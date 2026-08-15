import { it, expect } from "bun:test"
import { Effect, Layer } from "effect"
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
    yield* IterationBudget.consume(9)
    const out = yield* loopCommand("status")
    expect(out).toContain("Worker")
    expect(out).toContain("active")
    expect(out).toContain("10%")
    expect(out).toContain("Budget")
    expect(out).toContain("Verifier")
    expect(out).toContain("Timer")
  }).pipe(
    Effect.provide(testLayer),
    Effect.runPromise,
  ),
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
