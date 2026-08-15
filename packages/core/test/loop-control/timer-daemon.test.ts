import { describe, expect } from "bun:test"
import { Duration, Effect, Exit, Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { WorkerState } from "../../src/session/loop-control/worker-state"
import { EventBus, type LoopControlEvent } from "../../src/session/loop-control/event-bus"
import { TimerDaemon } from "../../src/session/loop-control/timer-daemon"
import { TerminalController } from "../../src/session/loop-control/terminal-controller"
import { testEffect } from "../lib/effect"

const loopControlLayer = Layer.provide(
  TimerDaemon.layerForTest,
  Layer.mergeAll(WorkerState.layerForTest, EventBus.layerForTest, TerminalController.layerForTest),
).pipe(
  Layer.merge(
    Layer.mergeAll(WorkerState.layerForTest, EventBus.layerForTest, TerminalController.layerForTest),
  ),
)

const it = testEffect(loopControlLayer)

describe("TimerDaemon", () => {
  it.effect("heartbeat fires only when worker is not Busy (Waiting/Idle)", () =>
    Effect.gen(function* () {
      const received: LoopControlEvent[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          received.push(e)
        }),
      )
      const timers = yield* TimerDaemon.Service
      yield* timers.start

      yield* TestClock.adjust(Duration.seconds(15))
      expect(received.filter((e) => e._tag === "HeartbeatTick")).toHaveLength(0)

      yield* WorkerState.transition({ _tag: "Waiting", reason: "OnChild" })
      yield* TestClock.adjust(Duration.seconds(25))
      const heartbeats = received.filter((e) => e._tag === "HeartbeatTick")
      expect(heartbeats.length).toBeGreaterThanOrEqual(2)
    }),
  )

  it.effect("waitIdleBackup fires only when worker is Idle (not Active)", () =>
    Effect.gen(function* () {
      const received: LoopControlEvent[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          received.push(e)
        }),
      )
      const timers = yield* TimerDaemon.Service
      yield* timers.start

      yield* TestClock.adjust(Duration.seconds(120))
      expect(received.filter((e) => e._tag === "WaitIdleBackupTick")).toHaveLength(0)

      yield* WorkerState.transition({ _tag: "Waiting", reason: "OnChild" })
      yield* TestClock.adjust(Duration.seconds(125))
      const ticks = received.filter((e) => e._tag === "WaitIdleBackupTick")
      expect(ticks.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect("stopReminder fires only when worker is Busy (not Idle)", () =>
    Effect.gen(function* () {
      const received: LoopControlEvent[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          received.push(e)
        }),
      )
      const timers = yield* TimerDaemon.Service
      yield* timers.start

      yield* TestClock.adjust(Duration.minutes(6))
      const reminders = received.filter((e) => e._tag === "StopReminder")
      expect(reminders.length).toBeGreaterThanOrEqual(1)

      received.length = 0
      yield* WorkerState.transition({ _tag: "Waiting", reason: "OnForegroundExec" })
      yield* TestClock.adjust(Duration.minutes(10))
      expect(received.filter((e) => e._tag === "StopReminder")).toHaveLength(0)
    }),
  )

  it.effect("loopTimer fires LoopTerminated after 24-hour ceiling", () =>
    Effect.gen(function* () {
      const received: LoopControlEvent[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          received.push(e)
        }),
      )
      const timers = yield* TimerDaemon.Service
      yield* timers.start

      yield* TestClock.adjust(Duration.hours(23))
      yield* TestClock.adjust(Duration.minutes(50))
      expect(received.filter((e) => e._tag === "LoopTerminated")).toHaveLength(0)

      yield* TestClock.adjust(Duration.minutes(20))
      const terminated = received.filter((e) => e._tag === "LoopTerminated")
      expect(terminated.length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.effect("loopTimer requests terminal hard_timeout while worker is Busy", () =>
    Effect.gen(function* () {
      const received: LoopControlEvent[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          received.push(e)
        }),
      )
      const timers = yield* TimerDaemon.Service
      yield* timers.start

      yield* TestClock.adjust(Duration.hours(24))
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("timed_out")
      expect(snap.reason).toBe("hard_timeout")
    }),
  )

  it.effect("loopTimer requests terminal hard_timeout while worker is Waiting", () =>
    Effect.gen(function* () {
      const received: LoopControlEvent[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          received.push(e)
        }),
      )
      const timers = yield* TimerDaemon.Service
      yield* timers.start
      yield* WorkerState.transition({ _tag: "Waiting", reason: "OnChild" })

      yield* TestClock.adjust(Duration.hours(24))
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("timed_out")
      expect(snap.reason).toBe("hard_timeout")
    }),
  )

  it.effect("pause masks stopReminder and freezes the 24h loop timer; heartbeat still fires", () =>
    Effect.gen(function* () {
      const received: LoopControlEvent[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          received.push(e)
        }),
      )
      const timers = yield* TimerDaemon.Service
      yield* timers.start
      yield* timers.pause

      yield* WorkerState.transition({ _tag: "Waiting", reason: "OnChild" })
      yield* TestClock.adjust(Duration.seconds(15))
      yield* TestClock.adjust(Duration.minutes(6))
      yield* TestClock.adjust(Duration.hours(24))

      expect(received.filter((e) => e._tag === "HeartbeatTick").length).toBeGreaterThanOrEqual(1)
      expect(received.filter((e) => e._tag === "StopReminder")).toHaveLength(0)
      expect(received.filter((e) => e._tag === "LoopTerminated")).toHaveLength(0)
      expect((yield* TerminalController.snapshot).reason).not.toBe("hard_timeout")

      yield* timers.resume
      yield* TestClock.adjust(Duration.hours(24))
      expect(received.filter((e) => e._tag === "LoopTerminated").length).toBeGreaterThanOrEqual(1)
      expect((yield* TerminalController.snapshot).reason).toBe("hard_timeout")
    }),
  )

  it.effect("no timer events fire after scope disposal", () =>
    Effect.gen(function* () {
      const received: LoopControlEvent[] = []
      const scope = yield* Effect.scope
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          received.push(e)
        }),
      )
      const timers = yield* TimerDaemon.Service
      yield* timers.start.pipe(Effect.forkIn(scope))

      yield* TestClock.adjust(Duration.minutes(10))
      expect(received.length).toBeGreaterThan(0)

      received.length = 0
      yield* Scope.close(scope, Exit.void)
      yield* TestClock.adjust(Duration.minutes(10))
      expect(received.filter((e) => e._tag === "StopReminder")).toHaveLength(0)
      expect(received.filter((e) => e._tag === "HeartbeatTick")).toHaveLength(0)
    }),
  )
})
