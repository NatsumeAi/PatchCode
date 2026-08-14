import { describe, expect, test } from "bun:test"
import { LLMClient, LLMError, LLMEvent, LLMResponse, Model, ProviderInternalReason, RateLimitReason, type LLMClientShape } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Effect, Layer, Stream } from "effect"
import { WorkerState } from "../../src/session/loop-control/worker-state"
import { EventBus } from "../../src/session/loop-control/event-bus"
import { IterationBudget } from "../../src/session/loop-control/iteration-budget"
import { TimerDaemon } from "../../src/session/loop-control/timer-daemon"
import { TerminalController } from "../../src/session/loop-control/terminal-controller"
import { CircuitBreaker } from "../../src/session/loop-control/circuit-breaker"
import { GoalStore } from "../../src/session/loop-control/goal-store"
import { TurnRetryState } from "../../src/session/runner/turn-retry-state"
import { VerifierBiDirectional } from "../../src/session/runner/verifier-bi-directional"
import { LoopControlHost } from "../../src/session/runner/loop-control-host"

const model = Model.make({ id: "test-model", provider: "test", route: OpenAIChat.route })
const unusedClient: LLMClientShape = {
  prepare: () => Effect.die("unused"),
  stream: () => Stream.die("unused"),
  generate: () => Effect.die("unused"),
}

const program = <A, E, R>(effect: Effect.Effect<A, E, R>, client: LLMClientShape = unusedClient) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(LoopControlHost.layerReal),
      Effect.provide(Layer.succeed(LLMClient.Service, client)),
      Effect.provide(VerifierBiDirectional.layerForTest),
      Effect.provide(GoalStore.layerForTest),
      Effect.provide(TurnRetryState.layerForTest),
      Effect.provide(IterationBudget.layerForTest(90)),
      Effect.provide(TimerDaemon.layerForTest),
      Effect.provide(EventBus.layerForTest),
      Effect.provide(WorkerState.layerForTest),
      Effect.provide(TerminalController.layerForTest),
      Effect.provide(CircuitBreaker.layerForTest),
  ) as Effect.Effect<A, E, never>,
)

const withParent = <T extends object>(event: T, parentSessionID: string) => {
  Object.defineProperty(event, "parentSessionID", { value: parentSessionID })
  return event
}

describe("LoopControlHost.layerReal", () => {
  test("onTurnStart transitions worker to Active and resets retry state", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        expect(yield* TurnRetryState.consume("rate_limit")).toBe(true)
        expect(yield* TurnRetryState.consume("rate_limit")).toBe(false)
        yield* hooks.onTurnStart({ sessionID: "s1", step: 1 })
        expect(yield* WorkerState.current).toEqual({ _tag: "Active" })
        expect(yield* TurnRetryState.consume("rate_limit")).toBe(true)
      }),
    ))

  test("onTurnEnd keeps Active when continuation is needed", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        yield* hooks.onTurnStart({ sessionID: "s1", step: 1 })
        yield* hooks.onTurnEnd({ sessionID: "s1", needsContinuation: true })
        expect(yield* WorkerState.current).toEqual({ _tag: "Active" })
      }),
    ))

  test("onTurnEnd goes Waiting when no continuation is needed", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        yield* hooks.onTurnStart({ sessionID: "s1", step: 1 })
        yield* hooks.onTurnEnd({ sessionID: "s1", needsContinuation: false })
        const state = yield* WorkerState.current
        expect(state._tag).toBe("Waiting")
      }),
    ))

  const rateLimitError = () =>
    new LLMError({
      module: "test",
      method: "test",
      reason: new RateLimitReason({ message: "rate limit hit", _tag: "RateLimit" }),
    })

  const providerInternalError = (status: number) =>
    new LLMError({
      module: "test",
      method: "test",
      reason: new ProviderInternalReason({ message: "server unavailable", _tag: "ProviderInternal", status }),
    })

  test("onFailover recovers on first occurrence of a reason", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        const first = yield* hooks.onFailover(rateLimitError())
        expect(first.recovered).toBe(true)
      }),
    ))

  test("onFailover hard-aborts on a repeated reason in the same turn", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        const first = yield* hooks.onFailover(rateLimitError())
        expect(first.recovered).toBe(true)
        const second = yield* hooks.onFailover(rateLimitError())
        expect(second.recovered).toBe(false)
      }),
    ))

  test("onFailover remains aborted after a repeated failure", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        yield* hooks.onFailover(providerInternalError(503))
        const again = yield* hooks.onFailover(providerInternalError(503))
        expect(again.recovered).toBe(false)
        yield* hooks.onTurnStart({ sessionID: "s1", step: 2 })
        const afterReset = yield* hooks.onFailover(providerInternalError(503))
        expect(afterReset.recovered).toBe(false)
      }),
    ))

  test("onStreamComplete with no goal is a no-op", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        yield* hooks.onStreamComplete({
          sessionID: "s1",
          finishReason: "stop",
          workerClaim: "Implemented the requested change.",
          workerDiffPath: "src/example.ts",
          model,
        })
      }),
    ))

  test("consumes abort requests at the next turn boundary", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        const bus = yield* EventBus.Service
        yield* hooks.onTurnStart({ sessionID: "s1", step: 1 })
        yield* bus.publish({ _tag: "AbortRequested", source: "test", at: 1 })
        expect(yield* WorkerState.current).toEqual({ _tag: "Dead", reason: "ParentAbort" })
        if (!hooks.shouldContinue) throw new Error("shouldContinue hook missing")
        expect(yield* hooks.shouldContinue("s1")).toBe(false)
      }),
    ))

  test("consumes subagent completion and returns worker to Active", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        const bus = yield* EventBus.Service
        yield* hooks.onTurnStart({ sessionID: "s1", step: 1 })
        yield* hooks.onTurnEnd({ sessionID: "s1", needsContinuation: false })
        yield* bus.publish({ _tag: "SubagentCompleted", parentSessionID: "s1", childSessionID: "child-1" })
        expect(yield* WorkerState.current).toEqual({ _tag: "Active" })
        if (!hooks.shouldContinue) throw new Error("shouldContinue hook missing")
        expect(yield* hooks.shouldContinue("s1")).toBe(true)
      }),
    ))

  test("ignores subagent completion owned by another parent session", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        const bus = yield* EventBus.Service
        yield* hooks.onTurnStart({ sessionID: "s1", step: 1 })
        yield* hooks.onTurnEnd({ sessionID: "s1", needsContinuation: false })
        yield* bus.publish({ _tag: "SubagentCompleted", parentSessionID: "s2", childSessionID: "child-2" })
        expect(yield* WorkerState.current).toEqual({ _tag: "Waiting", reason: "OnBackgroundExec" })
      }),
    ))

  test("consumes an owned subagent failure as a terminal parent failure", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        const bus = yield* EventBus.Service
        yield* hooks.onTurnStart({ sessionID: "s1", step: 1 })
        yield* hooks.onTurnEnd({ sessionID: "s1", needsContinuation: false })
        yield* bus.publish({
          _tag: "SubagentFailed",
          parentSessionID: "s1",
          childSessionID: "child-1",
          error: "child exploded",
        })
        expect(yield* WorkerState.current).toEqual({ _tag: "Dead", reason: "ParentAbort" })
        if (!hooks.shouldContinue) throw new Error("shouldContinue hook missing")
        expect(yield* hooks.shouldContinue("s1")).toBe(false)
      }),
    ))

  test("reuses one verifier per session so the reject cap spans turns", () => {
    let calls = 0
    const client: LLMClientShape = {
      prepare: () => Effect.die("unused"),
      stream: () => Stream.die("unused"),
      generate: () => {
        calls += 1
        const response = LLMResponse.fromEvents([
          LLMEvent.toolCall({
            id: `audit-${calls}`,
            name: "generate_object",
            input: { verdict: "rejected", reason: "Keep working" },
          }),
          LLMEvent.finish({ reason: "stop" }),
        ])
        if (!response) return Effect.die("test response did not finish")
        return Effect.succeed(response)
      },
    }

    return program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        yield* GoalStore.set("Finish the parser fix")
        for (let i = 0; i < 9; i++) {
          yield* hooks.onStreamComplete({
            sessionID: "s1",
            finishReason: "stop",
            workerClaim: `attempt ${i}`,
            workerDiffPath: "src/parser.ts",
            model,
          })
        }
        expect(calls).toBe(8)
      }),
      client,
    )
  })

  test("soft-injects reject when verifier provider fails (does not HardAbort drain)", () => {
    const client: LLMClientShape = {
      prepare: () => Effect.die("unused"),
      stream: () => Stream.die("unused"),
      generate: () => Effect.die("verifier provider failed"),
    }

    return program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        const bus = yield* EventBus.Service
        const vbd = yield* VerifierBiDirectional.Service
        yield* GoalStore.set("Finish the parser fix")
        yield* hooks.onStreamComplete({
          sessionID: "s1",
          finishReason: "stop",
          workerClaim: "Done",
          workerDiffPath: "src/parser.ts",
          model,
        })
        const events = yield* bus.snapshotBuffer(20)
        expect(events.some((e) => e._tag === "HardAbort" && e.reason === "verifier_failed")).toBe(false)
        // Soft path: circuit breaker recorded failure; next-turn context has reject text.
        const next = yield* vbd.getNextTurnSystemContext
        expect(next.verifier_reject_reason.toLowerCase()).toContain("verifier")
        if (hooks.shouldContinue) expect(yield* hooks.shouldContinue("s1")).toBe(true)
      }),
      client,
    )
  })

  test("Open circuit breaker makes shouldContinue false so no second stream", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        const breaker = yield* CircuitBreaker.Service
        yield* hooks.onTurnStart({ sessionID: "s1", step: 1, providerID: "fake" })
        for (let i = 0; i < 5; i++) yield* breaker.recordFailureFor("fake")
        expect(yield* breaker.stateFor("fake")).toBe("Open")
        if (!hooks.shouldContinue) throw new Error("shouldContinue hook missing")
        expect(yield* hooks.shouldContinue("s1")).toBe(false)
        expect(yield* breaker.allowRequest("fake")).toBe(false)
      }),
    ),
  )
})
