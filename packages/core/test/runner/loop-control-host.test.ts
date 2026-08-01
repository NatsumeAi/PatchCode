import { describe, test, expect } from "bun:test"
import { Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { Effect, Layer } from "effect"
import {
  LoopControlHost,
  type LoopControlHooks,
  type TurnStartCtx,
  type StreamEvent,
  type ToolCall,
  type StreamOutput,
  type TurnEndCtx,
} from "../../src/session/runner/loop-control-host"

const model = Model.make({ id: "test-model", provider: "test", route: OpenAIChat.route })

describe("LoopControlHost", () => {
  test("noop hooks: every hook returns Effect.void / { recovered: false }", () =>
    Effect.gen(function* () {
      const hooks = yield* LoopControlHost.Interface
      const ctx: TurnStartCtx = { sessionID: "s1", step: 1 }
      const ev: StreamEvent = { _tag: "chunk", sessionID: "s1" }
      const call: ToolCall = { name: "read", callID: "c1", sessionID: "s1" }
      const out: StreamOutput = {
        sessionID: "s1",
        finishReason: "stop",
        workerClaim: "done",
        workerDiffPath: "src/example.ts",
        model,
      }
      yield* hooks.onTurnStart(ctx)
      yield* hooks.onStream(ev)
      yield* hooks.onToolCall(call)
      yield* hooks.onStreamComplete(out)
      yield* hooks.onTurnEnd({ sessionID: "s1", needsContinuation: false })
      const failover = yield* hooks.onFailover(new Error("test"))
      expect(failover.recovered).toBe(false)
    }).pipe(Effect.provide(LoopControlHost.layerNoop), Effect.runPromise),
  )

  test("custom hooks: recording layer captures call order", () => {
    const calls: string[] = []
    const recordingHooks: LoopControlHooks = {
      onTurnStart: () => Effect.sync(() => calls.push("start")),
      onStream: () => Effect.sync(() => calls.push("stream")),
      onToolCall: () => Effect.sync(() => calls.push("tool")),
      onStreamComplete: () => Effect.sync(() => calls.push("complete")),
      onFailover: () => Effect.succeed({ recovered: false }),
      onTurnEnd: (_ctx: TurnEndCtx) => Effect.sync(() => calls.push("end")),
    }
    const layer = Layer.succeed(LoopControlHost.Interface, recordingHooks)
    return Effect.gen(function* () {
      const hooks = yield* LoopControlHost.Interface
      yield* hooks.onTurnStart({ sessionID: "s1", step: 1 })
      yield* hooks.onStream({ _tag: "chunk", sessionID: "s1" })
      yield* hooks.onStream({ _tag: "chunk", sessionID: "s1" })
      yield* hooks.onToolCall({ name: "read", callID: "c1", sessionID: "s1" })
      yield* hooks.onStreamComplete({
        sessionID: "s1",
        finishReason: "stop",
        workerClaim: "done",
        workerDiffPath: "src/example.ts",
        model,
      })
      yield* hooks.onTurnEnd({ sessionID: "s1", needsContinuation: false })
      expect(calls).toEqual(["start", "stream", "stream", "tool", "complete", "end"])
    }).pipe(Effect.provide(layer), Effect.runPromise)
  })

  test("top-level accessors forward to the active layer's hooks", () => {
    const calls: string[] = []
    const recordingHooks: LoopControlHooks = {
      onTurnStart: () => Effect.sync(() => calls.push("ts")),
      onStream: () => Effect.sync(() => calls.push("st")),
      onToolCall: () => Effect.sync(() => calls.push("tc")),
      onStreamComplete: () => Effect.sync(() => calls.push("sc")),
      onFailover: () => Effect.succeed({ recovered: true }),
      onTurnEnd: (_ctx: TurnEndCtx) => Effect.sync(() => calls.push("te")),
    }
    const layer = Layer.succeed(LoopControlHost.Interface, recordingHooks)
    return Effect.gen(function* () {
      yield* LoopControlHost.onTurnStart({ sessionID: "s", step: 2 })
      yield* LoopControlHost.onStream({ _tag: "chunk", sessionID: "s" })
      yield* LoopControlHost.onToolCall({ name: "w", callID: "c", sessionID: "s" })
      yield* LoopControlHost.onStreamComplete({
        sessionID: "s",
        finishReason: "stop",
        workerClaim: "done",
        workerDiffPath: "src/example.ts",
        model,
      })
      const fo = yield* LoopControlHost.onFailover(new Error("x"))
      yield* LoopControlHost.onTurnEnd({ sessionID: "s", needsContinuation: false })
      expect(calls).toEqual(["ts", "st", "tc", "sc", "te"])
      expect(fo.recovered).toBe(true)
    }).pipe(Effect.provide(layer), Effect.runPromise)
  })
})
