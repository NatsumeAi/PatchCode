export * as TimerDaemon from "./timer-daemon"

import { Context, Deferred, Duration, Effect, Layer, Schedule, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { EventBus } from "./event-bus"
import { WorkerState } from "./worker-state"
import { TerminalController } from "./terminal-controller"

const HEARTBEAT_INTERVAL = Duration.seconds(10)
const STOP_REMINDER_INTERVAL = Duration.minutes(5)
const WAIT_IDLE_BACKUP_INTERVAL = Duration.seconds(60)
const LOOP_TIMER_DURATION = Duration.hours(24)

/** Wait `interval` then recur — never fire on the same instant as start (avoids
 *  draining suites seeing StopReminder on the first Busy tick). */
const spacedSchedule = (interval: Duration.Duration) => Schedule.spaced(interval)

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
  }).pipe(Effect.repeat(spacedSchedule(HEARTBEAT_INTERVAL)))

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
  }).pipe(
    // First fire only after STOP_REMINDER_INTERVAL of Busy wall/clock time.
    Effect.delay(STOP_REMINDER_INTERVAL),
    Effect.repeat(spacedSchedule(STOP_REMINDER_INTERVAL)),
  )

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
  }).pipe(Effect.delay(WAIT_IDLE_BACKUP_INTERVAL), Effect.repeat(spacedSchedule(WAIT_IDLE_BACKUP_INTERVAL)))

const signal = (waiters: SynchronizedRef.SynchronizedRef<Array<Deferred.Deferred<void>>>) =>
  SynchronizedRef.modify(waiters, (ws) => [ws, [] as Array<Deferred.Deferred<void>>] as const).pipe(
    Effect.flatMap((pending) =>
      Effect.forEach(pending, (d) => Deferred.succeed(d, undefined).pipe(Effect.ignore), { discard: true }),
    ),
  )

/**
 * 24h boss ceiling. `/loop timer pause` freezes remaining time (does not merely
 * delay the fire until unpaused). Resume continues the leftover duration.
 */
const loopTimerDuration = (
  eventBus: EventBus.Interface,
  terminal: TerminalController.Interface,
  paused: SynchronizedRef.SynchronizedRef<boolean>,
  pauseWaiters: SynchronizedRef.SynchronizedRef<Array<Deferred.Deferred<void>>>,
  resumeWaiters: SynchronizedRef.SynchronizedRef<Array<Deferred.Deferred<void>>>,
) =>
  Effect.gen(function* () {
    let remaining = Duration.toMillis(LOOP_TIMER_DURATION)
    while (remaining > 0) {
      if (yield* SynchronizedRef.get(paused)) {
        const d = yield* Deferred.make<void>()
        yield* SynchronizedRef.update(resumeWaiters, (ws) => [...ws, d])
        if (!(yield* SynchronizedRef.get(paused))) {
          yield* Deferred.succeed(d, undefined).pipe(Effect.ignore)
        }
        yield* Deferred.await(d)
        continue
      }
      const t0 = yield* Effect.clockWith((c) => c.currentTimeMillis)
      const pauseGate = yield* Deferred.make<void>()
      yield* SynchronizedRef.update(pauseWaiters, (ws) => [...ws, pauseGate])
      if (yield* SynchronizedRef.get(paused)) {
        yield* Deferred.succeed(pauseGate, undefined).pipe(Effect.ignore)
      }
      const pauseHit = yield* Effect.sleep(Duration.millis(remaining)).pipe(
        Effect.as("elapsed" as const),
        Effect.raceFirst(Deferred.await(pauseGate).pipe(Effect.as("paused" as const))),
      )
      const t1 = yield* Effect.clockWith((c) => c.currentTimeMillis)
      const elapsed = Math.max(0, t1 - t0)
      if (pauseHit === "paused" || (yield* SynchronizedRef.get(paused))) {
        remaining = Math.max(0, remaining - elapsed)
        continue
      }
      remaining = 0
    }
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
  const pauseWaiters = yield* SynchronizedRef.make<Array<Deferred.Deferred<void>>>([])
  const resumeWaiters = yield* SynchronizedRef.make<Array<Deferred.Deferred<void>>>([])
  const start: Interface["start"] = Effect.gen(function* () {
    yield* heartbeatTick(workerState, eventBus).pipe(Effect.forkScoped)
    yield* stopReminderTick(workerState, eventBus, paused).pipe(Effect.forkScoped)
    yield* waitIdleBackupTick(workerState, eventBus, paused).pipe(Effect.forkScoped)
    yield* loopTimerDuration(eventBus, terminal, paused, pauseWaiters, resumeWaiters).pipe(Effect.forkScoped)
  })
  const pause: Interface["pause"] = Effect.gen(function* () {
    yield* SynchronizedRef.set(paused, true)
    yield* signal(pauseWaiters)
  })
  const resume: Interface["resume"] = Effect.gen(function* () {
    yield* SynchronizedRef.set(paused, false)
    yield* signal(resumeWaiters)
  })
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
