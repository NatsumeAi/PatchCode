import { describe, expect, test } from "bun:test"
import { LLMClient, LLMError, LLMEvent, LLMResponse, Model, InvalidProviderOutputReason, RateLimitReason, type LLMClientShape } from "@opencode-ai/llm"
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

describe("llm.ts loop-control integration (Task 3)", () => {
  test("shouldContinue delegates to TerminalController: approval stops continuation", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        if (!hooks.shouldContinue) throw new Error("shouldContinue hook missing")
        expect(yield* hooks.shouldContinue("s1")).toBe(true)
        yield* TerminalController.request("verifier_approved")
        expect(yield* hooks.shouldContinue("s1")).toBe(false)
      }),
    ))

  test("verifier approval via onStreamComplete stops further continuation", () => {
    const client: LLMClientShape = {
      prepare: () => Effect.die("unused"),
      stream: () => Stream.die("unused"),
      generate: () => {
        const response = LLMResponse.fromEvents([
          LLMEvent.toolCall({
            id: "audit-1",
            name: "generate_object",
            input: { verdict: "approved", reason: "All checks pass" },
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
        if (!hooks.shouldContinue) throw new Error("shouldContinue hook missing")
        yield* GoalStore.set("Finish the feature")
        yield* hooks.onStreamComplete({
          sessionID: "s1",
          finishReason: "stop",
          workerClaim: "Done.",
          workerDiffPath: "src/x.ts",
          model,
        })
        expect(yield* hooks.shouldContinue("s1")).toBe(false)
        const snap = yield* TerminalController.snapshot
        expect(snap.state).toBe("terminated")
        expect(snap.reason).toBe("verifier_approved")
      }),
      client,
    )
  })

  test("abort before next turn boundary stops continuation via TerminalController", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        if (!hooks.shouldContinue) throw new Error("shouldContinue hook missing")
        yield* hooks.onTurnStart({ sessionID: "s1", step: 1 })
        expect(yield* hooks.shouldContinue("s1")).toBe(true)
        yield* TerminalController.request("user_abort")
        expect(yield* hooks.shouldContinue("s1")).toBe(false)
        const snap = yield* TerminalController.snapshot
        expect(snap.state).toBe("aborted")
      }),
    ))

  test("hard timeout via TerminalController stops continuation", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        if (!hooks.shouldContinue) throw new Error("shouldContinue hook missing")
        yield* TerminalController.request("hard_timeout")
        expect(yield* hooks.shouldContinue("s1")).toBe(false)
        const snap = yield* TerminalController.snapshot
        expect(snap.state).toBe("timed_out")
      }),
    ))

  test("budget exhaustion stops continuation", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        if (!hooks.shouldContinue) throw new Error("shouldContinue hook missing")
        yield* TerminalController.request("budget_exhausted")
        expect(yield* hooks.shouldContinue("s1")).toBe(false)
        const snap = yield* TerminalController.snapshot
        expect(snap.state).toBe("budget_exhausted")
      }),
    ))

  test("unrecoverable failure stops continuation", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        if (!hooks.shouldContinue) throw new Error("shouldContinue hook missing")
        yield* TerminalController.request("unrecoverable_failure")
        expect(yield* hooks.shouldContinue("s1")).toBe(false)
        const snap = yield* TerminalController.snapshot
        expect(snap.state).toBe("failed")
      }),
    ))

  test("verifier rejection leaves the loop continuable (terminal state stays running)", () => {
    const client: LLMClientShape = {
      prepare: () => Effect.die("unused"),
      stream: () => Stream.die("unused"),
      generate: () => {
        const response = LLMResponse.fromEvents([
          LLMEvent.toolCall({
            id: "audit-1",
            name: "generate_object",
            input: { verdict: "rejected", reason: "Still has a bug" },
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
        if (!hooks.shouldContinue) throw new Error("shouldContinue hook missing")
        yield* GoalStore.set("Finish the feature")
        yield* hooks.onStreamComplete({
          sessionID: "s1",
          finishReason: "stop",
          workerClaim: "Done?",
          workerDiffPath: "src/x.ts",
          model,
        })
        expect(yield* hooks.shouldContinue("s1")).toBe(true)
        const snap = yield* TerminalController.snapshot
        expect(snap.state).toBe("running")
      }),
      client,
    )
  })
})

describe("llm.ts failover routing (Task 4)", () => {
  const rateLimitError = () =>
    new LLMError({
      module: "test",
      method: "test",
      reason: new RateLimitReason({ message: "rate limit hit", _tag: "RateLimit" }),
    })

  test("onFailover recovers a transient rate-limit failure once", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        const recovered = yield* hooks.onFailover(rateLimitError())
        expect(recovered.recovered).toBe(true)
      }),
    ))

  test("duplicate same-reason failure does not recover (one-shot)", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        yield* hooks.onFailover(rateLimitError())
        const second = yield* hooks.onFailover(rateLimitError())
        expect(second.recovered).toBe(false)
      }),
    ))

  test("exhausted retry admission requests terminal unrecoverable_failure", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        yield* hooks.onFailover(rateLimitError())
        yield* hooks.onFailover(rateLimitError())
        const snap = yield* TerminalController.snapshot
        expect(snap.state).toBe("failed")
        expect(snap.reason).toBe("unrecoverable_failure")
      }),
    ))

  test("a non-retryable LLMError does not recover and requests terminal failure", () =>
    program(
      Effect.gen(function* () {
        const hooks = yield* LoopControlHost.Interface
        const err = new LLMError({
          module: "LLM",
          method: "stream",
          reason: new InvalidProviderOutputReason({ message: "malformed" }),
        })
        const recovered = yield* hooks.onFailover(err)
        expect(recovered.recovered).toBe(false)
        const snap = yield* TerminalController.snapshot
        expect(snap.state).toBe("failed")
        expect(snap.reason).toBe("unrecoverable_failure")
      }),
    ))
})
