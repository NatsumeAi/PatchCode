import { it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"
import { TerminalController } from "@opencode-ai/core/session/loop-control/terminal-controller"
import { loopCommand } from "@/cli/cmd/run/loop/loop-cmd"

const testLayer = Layer.mergeAll(EventBus.layerForTest, TerminalController.layerForTest)

it("/loop abort 发 AbortRequested event 到 EventBus 并请求 TerminalController", () =>
  Effect.gen(function* () {
    const received: string[] = []
    yield* EventBus.subscribe((e) =>
      Effect.sync(() => {
        if (e._tag === "AbortRequested") received.push(e.source)
      }),
    )
    const out = yield* loopCommand("abort")
    expect(out).toContain("abort requested")
    expect(received).toEqual(["user-cli"])
    const snap = yield* TerminalController.snapshot
    expect(snap.state).toBe("aborted")
    expect(snap.reason).toBe("user_abort")
  }).pipe(
    Effect.provide(testLayer),
    Effect.runPromise,
  ),
)
