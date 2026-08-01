export * as TimerDaemon from "./timer-daemon"

import { Context, Duration, Effect, Layer, Schedule, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { EventBus } from "./event-bus"
import { WorkerState } from "./worker-state"
import { TerminalController } from "./terminal-controller"

const HEARTBEAT_INTERVAL = Duration.seconds(10)
const STOP_REMINDER_INTERVAL = Duration.minutes(5)
const WAIT_IDLE_BACKUP_INTERVAL = Duration.seconds(60)
const LOOP_TIMER_DURATION = Duration.hours(24)

const fixedSchedule = (interval: Duration.Duration) => Schedule.fixed(interval)

const heartbeatTick = (
  workerState: WorkerState.Interface,
  eventBus: EventBus.Interface,
) =>
  Effect.gen(function* () {
    const h = yield* workerState.currentHarness
    if (h !== "Busy") {
      const time = yield* Effect.clockWith((c) => c.currentTimeMillis)
      yield* eventBus.publish({ _tag: "HeartbeatTick", time })
    }
  }).pipe(Effect.repeat(fixedSchedule(HEARTBEAT_INTERVAL)))

const stopReminderTick = (
  workerState: WorkerState.Interface,
  eventBus: EventBus.Interface,
  paused: SynchronizedRef.SynchronizedRef<boolean>,
) =>
  Effect.gen(function* () {
    const p = yield* SynchronizedRef.get(paused)
    if (!p) {
      const h = yield* workerState.currentHarness
      if (h === "Busy") {
        yield* eventBus.publish({ _tag: "StopReminder", reason: "no_heartbeat_within_5min" })
      }
    }
  }).pipe(Effect.repeat(fixedSchedule(STOP_REMINDER_INTERVAL)))

const waitIdleBackupTick = (
  workerState: WorkerState.Interface,
  eventBus: EventBus.Interface,
  paused: SynchronizedRef.SynchronizedRef<boolean>,
) =>
  Effect.gen(function* () {
    const p = yield* SynchronizedRef.get(paused)
    if (!p) {
      const h = yield* workerState.currentHarness
      if (h === "Idle") {
        yield* eventBus.publish({ _tag: "WaitIdleBackupTick", reason: "idle_status_check" })
      }
    }
  }).pipe(Effect.repeat(fixedSchedule(WAIT_IDLE_BACKUP_INTERVAL)))

const loopTimerDuration = (
  eventBus: EventBus.Interface,
  terminal: TerminalController.Interface,
) =>
  Effect.gen(function* () {
    yield* Effect.sleep(LOOP_TIMER_DURATION)
    yield* terminal.request("hard_timeout")
    yield* eventBus.publish({ _tag: "LoopTerminated", reason: "loop_timer_reached_24h" })
  })

export interface Interface {
  readonly start: Effect.Effect<void, never, import("effect").Scope.Scope>
  readonly pause: Effect.Effect<void>
  readonly resume: Effect.Effect<void>
  readonly isPaused: Effect.Effect<boolean>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/TimerDaemon")

export const make = Effect.gen(function* () {
  const workerState = yield* WorkerState.Service
  const eventBus = yield* EventBus.Service
  const terminal = yield* TerminalController.Service
  const paused = yield* SynchronizedRef.make(false)
  const start: Interface["start"] = Effect.gen(function* () {
    yield* heartbeatTick(workerState, eventBus).pipe(Effect.forkScoped)
    yield* stopReminderTick(workerState, eventBus, paused).pipe(Effect.forkScoped)
    yield* waitIdleBackupTick(workerState, eventBus, paused).pipe(Effect.forkScoped)
    yield* loopTimerDuration(eventBus, terminal).pipe(Effect.forkScoped)
  })
  const pause: Interface["pause"] = SynchronizedRef.update(paused, () => true)
  const resume: Interface["resume"] = SynchronizedRef.update(paused, () => false)
  const isPaused: Interface["isPaused"] = SynchronizedRef.get(paused)
  return { start, pause, resume, isPaused }
})

export const layerForTest = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [WorkerState.node, EventBus.node, TerminalController.node] })

export const pause: Effect.Effect<void, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  yield* svc.pause
})

export const resume: Effect.Effect<void, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  yield* svc.resume
})

export const isPaused: Effect.Effect<boolean, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.isPaused
})
