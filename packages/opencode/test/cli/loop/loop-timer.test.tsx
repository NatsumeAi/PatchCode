import { it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { TimerDaemon } from "@opencode-ai/core/session/loop-control/timer-daemon"
import { WorkerState } from "@opencode-ai/core/session/loop-control/worker-state"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"
import { TerminalController } from "@opencode-ai/core/session/loop-control/terminal-controller"
import { loopCommand } from "@/cli/cmd/run/loop/loop-cmd"

const timerWithDeps = TimerDaemon.layerForTest.pipe(
  Layer.provide(Layer.mergeAll(WorkerState.layerForTest, EventBus.layerForTest, TerminalController.layerForTest)),
)

it("/loop timer pause/resume 切换 overlay", () =>
  Effect.gen(function* () {
    const out = yield* loopCommand("timer pause")
    expect(out).toContain("paused")
    const paused = yield* TimerDaemon.isPaused
    expect(paused).toBe(true)
    yield* loopCommand("timer resume")
    expect(yield* TimerDaemon.isPaused).toBe(false)
  }).pipe(
    Effect.provide(timerWithDeps),
    Effect.runPromise,
  ),
)

it("/loop timer show 显示 daemon 配置", () =>
  Effect.gen(function* () {
    const out = yield* loopCommand("timer")
    expect(out).toContain("loopTimer 24h00m")
  }).pipe(
    Effect.provide(timerWithDeps),
    Effect.runPromise,
  ),
)
