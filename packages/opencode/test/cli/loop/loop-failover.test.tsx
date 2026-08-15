import { it, expect } from "bun:test"
import { Effect } from "effect"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"
import { loopCommand } from "@/cli/cmd/run/loop/loop-cmd"

it("/loop failover 显示 hard aborts", () =>
  Effect.gen(function* () {
    yield* EventBus.publish({ _tag: "HardAbort", reason: "loop_timer_reached_24h" })
    const out = yield* loopCommand("failover")
    expect(out).toContain("hard aborts: 1")
    expect(out).toContain("loop_timer_reached_24h")
  }).pipe(
    Effect.provide(EventBus.layerForTest),
    Effect.runPromise,
  ),
)

it("/loop failover 无记录时显示 no retries", () =>
  Effect.gen(function* () {
    const out = yield* loopCommand("failover")
    expect(out).toContain("no retries recorded")
  }).pipe(
    Effect.provide(EventBus.layerForTest),
    Effect.runPromise,
  ),
)

it("/loop failover 优雅降级当 bus 不可用", () =>
  Effect.gen(function* () {
    const out = yield* loopCommand("failover")
    expect(out).toContain("loop-control bus unavailable")
  }).pipe(Effect.runPromise),
)
