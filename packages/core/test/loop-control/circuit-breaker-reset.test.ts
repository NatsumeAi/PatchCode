import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CircuitBreaker } from "../../src/session/loop-control/circuit-breaker"
import { loopCommand } from "../../src/session/loop-control/command"
import { EventBus } from "../../src/session/loop-control/event-bus"
import { GoalStore } from "../../src/session/loop-control/goal-store"
import { IterationBudget } from "../../src/session/loop-control/iteration-budget"
import { TerminalController } from "../../src/session/loop-control/terminal-controller"
import { TimerDaemon } from "../../src/session/loop-control/timer-daemon"
import { WorkerState } from "../../src/session/loop-control/worker-state"

test("/loop breaker reset closes open circuit", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const breaker = yield* CircuitBreaker.make(2)
      yield* breaker.recordFailure
      yield* breaker.recordFailure
      expect(yield* breaker.state).toBe("Open")
      const eventBus = yield* EventBus.make
      const goalStore = yield* GoalStore.make
      const budget = yield* IterationBudget.make(90)
      const terminal = yield* TerminalController.make
      const workerState = yield* WorkerState.make
      const timerDaemon = yield* TimerDaemon.make.pipe(
        Effect.provideService(WorkerState.Service, workerState),
        Effect.provideService(EventBus.Service, eventBus),
        Effect.provideService(TerminalController.Service, terminal),
      )
      const text = yield* loopCommand("breaker reset").pipe(
        Effect.provideService(EventBus.Service, eventBus),
        Effect.provideService(GoalStore.Service, goalStore),
        Effect.provideService(IterationBudget.Service, budget),
        Effect.provideService(TimerDaemon.Service, timerDaemon),
        Effect.provideService(WorkerState.Service, workerState),
        Effect.provideService(TerminalController.Service, terminal),
        Effect.provideService(CircuitBreaker.Service, breaker),
      )
      expect(text).toContain("reset")
      expect(yield* breaker.state).toBe("Closed")
    }),
  )
})
