import { describe, expect, test } from "bun:test"
import { LLMClient, LLMEvent, LLMResponse, Model, type LLMClientShape } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Effect, Exit, Layer, Stream } from "effect"
import { LoopControlHost } from "../../src/session/runner/loop-control-host"
import { SessionRuntime } from "../../src/session/runtime"

// Pinned across every makeSessionHooks call below: LLMClient is location-scoped in
// production, but for these isolation tests the auditor factory reads only its
// shape, so one fixed unused client captures the dependency for the whole scope.
const unusedClient: LLMClientShape = {
  prepare: () => Effect.die("unused"),
  stream: () => Stream.die("unused"),
  generate: () => Effect.die("unused"),
}
const rejectingModel = Model.make({ id: "test-model", provider: "test", route: OpenAIChat.route })

describe("SessionRuntime", () => {
  test("isolates mutable loop state by session ID", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SessionRuntime.Service
        const first = yield* runtime.getOrCreate("s1")
        const second = yield* runtime.getOrCreate("s2")

        yield* first.terminal.request("user_abort")
        yield* first.budget.consume(1)

        expect(yield* first.terminal.shouldContinue).toBe(false)
        expect(yield* second.terminal.shouldContinue).toBe(true)
        expect(yield* second.budget.remaining).toBe(second.budget.cap)
        expect(first.workerState).not.toBe(second.workerState)
      }).pipe(Effect.provide(SessionRuntime.layerForTest)),
    ))

  test("getOrCreate is idempotent per session ID", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SessionRuntime.Service
        const first = yield* runtime.getOrCreate("s1")
        const again = yield* runtime.getOrCreate("s1")
        expect(again).toBe(first)
      }).pipe(Effect.provide(SessionRuntime.layerForTest)),
    ))

  test("resetForDrain recovers a Dead worker and budget/retry but keeps a hard terminal", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SessionRuntime.Service
        const inst = yield* runtime.getOrCreate("s1")

        yield* inst.terminal.request("user_abort")
        yield* inst.budget.consume(2)
        yield* inst.retry.consume("rate_limited")
        yield* inst.workerState.transition({ _tag: "Dead", reason: "ParentAbort" })

        expect(yield* inst.terminal.shouldContinue).toBe(false)
        expect(yield* inst.workerState.currentHarness).toBe("Stuck")
        expect((yield* inst.workerState.current)._tag).toBe("Dead")

        yield* runtime.resetForDrain("s1")

        expect(yield* inst.terminal.shouldContinue).toBe(false)
        expect((yield* inst.terminal.snapshot).reason).toBe("user_abort")
        expect(yield* inst.budget.remaining).toBe(inst.budget.cap)
        expect(yield* inst.retry.consume("rate_limited")).toBe(true)
        expect((yield* inst.workerState.current)._tag).toBe("Active")
        expect(yield* inst.workerState.currentHarness).toBe("Busy")

        yield* inst.terminal.reset
        expect(yield* inst.terminal.shouldContinue).toBe(true)
        expect((yield* inst.terminal.snapshot).state).toBe("running")
      }).pipe(Effect.provide(SessionRuntime.layerForTest)),
    ))

  test("production breaker on a session instance opens after consecutive failures", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SessionRuntime.Service
        const inst = yield* runtime.getOrCreate("breaker")
        expect(yield* inst.circuitBreaker.state).toBe("Closed")
        for (let i = 0; i < 5; i++) yield* inst.circuitBreaker.recordFailure
        expect(yield* inst.circuitBreaker.state).toBe("Open")
        expect(yield* inst.circuitBreaker.allowRequest()).toBe(false)
      }).pipe(Effect.provide(SessionRuntime.layerForTest)),
    ))

  test("resetForDrain on one session leaves an unrelated session untouched", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SessionRuntime.Service
        const a = yield* runtime.getOrCreate("a")
        const b = yield* runtime.getOrCreate("b")

        yield* a.terminal.request("user_abort")
        yield* runtime.resetForDrain("a")

        expect(yield* a.terminal.shouldContinue).toBe(false)
        expect(yield* b.terminal.shouldContinue).toBe(true)
      }).pipe(Effect.provide(SessionRuntime.layerForTest)),
    ))

  test("current returns the existing instance for a known session", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SessionRuntime.Service
        const created = yield* runtime.getOrCreate("known")
        const looked = yield* runtime.current("known")
        expect(looked).toBe(created)
      }).pipe(Effect.provide(SessionRuntime.layerForTest)),
    ))

  test("current fails with SessionNotFound for an unknown session", async () => {
    const program = Effect.gen(function* () {
      const runtime = yield* SessionRuntime.Service
      yield* runtime.current("nope")
    }).pipe(Effect.provide(SessionRuntime.layerForTest))

    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
    const err = Exit.isFailure(exit)
      ? JSON.stringify(exit.cause)
      : ""
    expect(err).toContain("SessionNotFound")
    expect(err).toContain("nope")
  })

  test("release removes the instance so a subsequent current fails", async () => {
    const program = Effect.gen(function* () {
      const runtime = yield* SessionRuntime.Service
      yield* runtime.getOrCreate("ephemeral")
      yield* runtime.release("ephemeral")
      yield* runtime.current("ephemeral")
    }).pipe(Effect.provide(SessionRuntime.layerForTest))

    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("release is idempotent — a second release is a no-op", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* SessionRuntime.Service
        yield* runtime.getOrCreate("idem")
        yield* runtime.release("idem")
        yield* runtime.release("idem")
        yield* runtime.getOrCreate("idem")
      }).pipe(Effect.provide(SessionRuntime.layerForTest)),
    ))

  test("binds child failure handling to the owning session", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SessionRuntime.Service
          const first = yield* runtime.getOrCreate("s1")
          const second = yield* runtime.getOrCreate("s2")
          const firstHooks = yield* LoopControlHost.makeSessionHooks("s1", first)
          const secondHooks = yield* LoopControlHost.makeSessionHooks("s2", second)

          yield* firstHooks.onTurnStart({ sessionID: "s1", step: 1 })
          yield* secondHooks.onTurnStart({ sessionID: "s2", step: 1 })
          yield* firstHooks.onTurnEnd({ sessionID: "s1", needsContinuation: false })
          yield* secondHooks.onTurnEnd({ sessionID: "s2", needsContinuation: false })
          yield* first.eventBus.publish({
            _tag: "SubagentFailed",
            parentSessionID: "s1",
            childSessionID: "child-1",
            error: "child failed",
          })

          expect((yield* first.workerState.current)._tag).toBe("Dead")
          expect((yield* second.workerState.current)._tag).toBe("Waiting")
          if (!secondHooks.shouldContinue) throw new Error("shouldContinue hook missing")
          expect(yield* secondHooks.shouldContinue("s2")).toBe(true)
        }),
      ).pipe(
        Effect.provide(SessionRuntime.layerForTest),
        Effect.provide(Layer.succeed(LLMClient.Service, unusedClient)),
      ),
    ))

  test("makeSessionHooks finalizer removes the EventBus subscription when its scope closes", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SessionRuntime.Service
          const s1 = yield* runtime.getOrCreate("s1")

          yield* Effect.scoped(
            Effect.gen(function* () {
              const hooks = yield* LoopControlHost.makeSessionHooks("s1", s1)
              yield* hooks.onTurnStart({ sessionID: "s1", step: 1 })
              yield* hooks.onTurnEnd({ sessionID: "s1", needsContinuation: false })
              expect((yield* s1.workerState.current)._tag).toBe("Waiting")
              yield* s1.eventBus.publish({
                _tag: "SubagentFailed",
                parentSessionID: "s1",
                childSessionID: "c",
                error: "boom",
              })
              expect((yield* s1.workerState.current)._tag).toBe("Dead")
            }),
          )

          yield* runtime.resetForDrain("s1")
          expect((yield* s1.workerState.current)._tag).toBe("Active")
          yield* s1.eventBus.publish({
            _tag: "SubagentFailed",
            parentSessionID: "s1",
            childSessionID: "c",
            error: "boom",
          })
          expect((yield* s1.workerState.current)._tag).toBe("Active")
        }),
      ).pipe(
        Effect.provide(SessionRuntime.layerForTest),
        Effect.provide(Layer.succeed(LLMClient.Service, unusedClient)),
      ),
    ))

  test("publishes one verifier rejection event with the actual reason", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* SessionRuntime.Service
          const instance = yield* runtime.getOrCreate("s1")
          const events: string[] = []
          yield* instance.eventBus.subscribe((event) =>
            Effect.sync(() => {
              if (event._tag === "VerifierRejectInjected") events.push(event.reason)
            }),
          )
          const response = LLMResponse.fromEvents([
            LLMEvent.toolCall({
              id: "audit-1",
              name: "generate_object",
              input: { verdict: "rejected", reason: "Keep working" },
            }),
            LLMEvent.finish({ reason: "stop" }),
          ])
          if (!response) throw new Error("test response did not finish")
          const client: LLMClientShape = {
            ...unusedClient,
            generate: () => Effect.succeed(response),
          }
          const hooks = yield* LoopControlHost.makeSessionHooks("s1", instance).pipe(
            Effect.provideService(LLMClient.Service, client),
          )
          yield* instance.goalStore.set("Finish the parser fix")
          yield* hooks.onStreamComplete({
            sessionID: "s1",
            finishReason: "stop",
            workerClaim: "Done?",
            workerDiffPath: "src/example.ts",
            model: rejectingModel,
          })
          expect(events).toEqual(["Keep working"])
        }),
      ).pipe(
        Effect.provide(SessionRuntime.layerForTest),
        Effect.provide(Layer.succeed(LLMClient.Service, unusedClient)),
      ),
    ))
})
