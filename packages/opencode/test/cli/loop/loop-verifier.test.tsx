import { it, expect } from "bun:test"
import { Effect } from "effect"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"
import { loopCommand } from "@/cli/cmd/run/loop/loop-cmd"

it("/loop verifier 显示 reject count", () =>
  Effect.gen(function* () {
    yield* EventBus.publish({ _tag: "VerifierRejectInjected", reason: "tests failed" })
    const out = yield* loopCommand("verifier")
    expect(out).toContain("reject count: 1")
    expect(out).toContain("tests failed")
  }).pipe(
    Effect.provide(EventBus.layerForTest),
    Effect.runPromise,
  ),
)

it("/loop verifier 无 audit 时显示 Fresh", () =>
  Effect.gen(function* () {
    const out = yield* loopCommand("verifier")
    expect(out).toContain("Fresh")
  }).pipe(
    Effect.provide(EventBus.layerForTest),
    Effect.runPromise,
  ),
)
