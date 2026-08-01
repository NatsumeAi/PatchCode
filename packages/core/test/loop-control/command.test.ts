import { expect, it } from "bun:test"
import { Effect } from "effect"
import { loopCommand } from "@opencode-ai/core/session/loop-control/command"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"
import { GoalStore } from "@opencode-ai/core/session/loop-control/goal-store"
import { IterationBudget } from "@opencode-ai/core/session/loop-control/iteration-budget"
import { TimerDaemon } from "@opencode-ai/core/session/loop-control/timer-daemon"
import { TerminalController } from "@opencode-ai/core/session/loop-control/terminal-controller"
import { WorkerState } from "@opencode-ai/core/session/loop-control/worker-state"

it("dispatches loop status from the core loop-control package", async () => {
  const output = await loopCommand("status").pipe(
    Effect.provide(IterationBudget.layerForTest(90)),
    Effect.provide(TimerDaemon.layerForTest),
    Effect.provide(TerminalController.layerForTest),
    Effect.provide(WorkerState.layerForTest),
    Effect.provide(EventBus.layerForTest),
    Effect.provide(GoalStore.layerForTest),
    Effect.runPromise,
  )

  expect(output).toContain("Worker")
  expect(output).toContain("Budget")
  expect(output).not.toContain("turn 0/60")
  expect(output).not.toContain("24h00m")
  expect(output).not.toContain("last audit")
})
