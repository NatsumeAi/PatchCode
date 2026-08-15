import { it, expect } from "bun:test"
import { Effect } from "effect"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"
import { loopCommand } from "@/cli/cmd/run/loop/loop-cmd"

it("/loop history 显示最近 N 个 loop event", () =>
  Effect.gen(function* () {
    yield* EventBus.publish({ _tag: "HeartbeatTick", time: 1 })
    yield* EventBus.publish({ _tag: "StopReminder", reason: "busy" })
    yield* EventBus.publish({ _tag: "LoopTerminated", reason: "24h" })
    const out = yield* loopCommand("history")
    expect(out).toContain("HeartbeatTick")
    expect(out).toContain("StopReminder")
    expect(out).toContain("LoopTerminated")
  }).pipe(
    Effect.provide(EventBus.layerForTest),
    Effect.runPromise,
  ),
)
