import { it, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { renderLoopStatus } from "@/cli/cmd/run/loop/loop-status"
import { loopCommand } from "@/cli/cmd/run/loop/loop-cmd"
import { IterationBudget } from "@opencode-ai/core/session/loop-control/iteration-budget"
import { TimerDaemon } from "@opencode-ai/core/session/loop-control/timer-daemon"
import { WorkerState } from "@opencode-ai/core/session/loop-control/worker-state"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"
import { GoalStore } from "@opencode-ai/core/session/loop-control/goal-store"
import { TerminalController } from "@opencode-ai/core/session/loop-control/terminal-controller"

const timerWithDeps = TimerDaemon.layerForTest.pipe(
  Layer.provide(Layer.mergeAll(WorkerState.layerForTest, EventBus.layerForTest, TerminalController.layerForTest)),
)

const testLayer = Layer.mergeAll(
  IterationBudget.layerForTest(90),
  timerWithDeps,
  WorkerState.layerForTest,
  EventBus.layerForTest,
  GoalStore.layerForTest,
  TerminalController.layerForTest,
)

it("/loop status 输出含 worker/verifier/budget/timer 四块", () =>
  Effect.gen(function* () {
    const out = yield* renderLoopStatus({
      worker: { _tag: "Active", turn: 3, stepCap: 60, depth: 1 },
      verifier: { _tag: "Reused", rejectCount: 0, lastAuditAt: Date.now() - 120_000 },
      budget: { consumed: 9, cap: 90 },
      timer: {
        loopTimerMs: 86_400_000,
        stopReminderMs: 300_000,
        stopReminderActive: true,
        waitIdleBackupMs: 60_000,
        waitIdleBackupActive: false,
      },
      lastEvents: [
        { _tag: "onTurnEnd" },
        { _tag: "onStream", durationMs: 7_000 },
        { _tag: "onToolCall", tool: "edit" },
      ],
      terminal: { state: "running", reason: null },
    })
    expect(out).toContain("Worker")
    expect(out).toContain("active")
    expect(out).toContain("10%")
    expect(out).toContain("stopReminder 5m00m active")
    expect(out).toContain("onToolCall(edit)")
  }).pipe(Effect.runPromise),
)

it("/loop status dispatches through loopCommand", () =>
  Effect.gen(function* () {
    const out = yield* loopCommand("status")
    expect(out).toContain("Worker")
    expect(out).toContain("Budget")
  }).pipe(
    Effect.provide(testLayer),
    Effect.runPromise,
  ),
)

it("/loop status 包含 live terminal state", () =>
  Effect.gen(function* () {
    yield* TerminalController.request("hard_timeout")
    const out = yield* loopCommand("status")
    expect(out).toContain("Terminal")
    expect(out).toContain("timed_out")
    expect(out).toContain("hard_timeout")
  }).pipe(
    Effect.provide(testLayer),
    Effect.runPromise,
  ),
)
