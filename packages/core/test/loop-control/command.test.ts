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
  // Successive provide (Effect 4 Layer.mergeAll can drop services depending on order).
  const program = loopCommand("status").pipe(
    Effect.provide(IterationBudget.layerForTest(90)),
    Effect.provide(TimerDaemon.layerForTest),
    Effect.provide(TerminalController.layerForTest),
    Effect.provide(WorkerState.layerForTest),
    Effect.provide(EventBus.layerForTest),
    Effect.provide(GoalStore.layerForTest),
  ) as Effect.Effect<string>
  const output = await Effect.runPromise(program)

  expect(output).toContain("Worker")
  expect(output).toContain("Budget")
  expect(output).toContain("Verifier")
  expect(output).toContain("Fresh (no audits yet)")
  expect(output).toContain("Timer")
  expect(output).toContain("loopTimer 24h")
  expect(output).not.toContain("turn 0/60")
  expect(output).not.toContain("24h00m")
  expect(output).not.toContain("last audit")
})

it("sets the goal from /loop goal <text> without requiring --set", async () => {
  const program = loopCommand("goal ship the loop module").pipe(
    Effect.provide(GoalStore.layerForTest),
  ) as Effect.Effect<string>
  const output = await Effect.runPromise(program)
  expect(output).toBe("goal: ship the loop module")
})
