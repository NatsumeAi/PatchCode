export * as SubagentHeartbeat from "./subagent-heartbeat"

import { Context, Duration, Effect, Fiber, Layer, Schedule, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { EventBus } from "./event-bus"

const HEARTBEAT_INTERVAL = Duration.seconds(30)
const HEARTBEAT_LOSS_TIMEOUT_MS = 60_000
const WATCHER_POLL_INTERVAL = Duration.seconds(1)

export interface Interface {
  readonly startForChild: (childSessionID: string) => Effect.Effect<void, never, import("effect").Scope.Scope>
  readonly startWatcherForChild: (childSessionID: string) => Effect.Effect<void, never, import("effect").Scope.Scope>
  readonly stopForChild: (childSessionID: string) => Effect.Effect<void>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/SubagentHeartbeat")

export const make: Effect.Effect<Interface, never, EventBus.Interface> = Effect.gen(function* () {
  const eventBus = yield* EventBus.Service
  const disposers = yield* SynchronizedRef.make(new Map<string, Effect.Effect<void>>())

  const startForChild: Interface["startForChild"] = (childSessionID) =>
    Effect.gen(function* () {
      const beat = Effect.gen(function* () {
        const timestamp = yield* Effect.clockWith((c) => c.currentTimeMillis)
        yield* eventBus.publish({ _tag: "SubagentHeartbeat", childSessionID, timestamp })
      }).pipe(Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL)))
      const fiber = yield* beat.pipe(Effect.forkScoped)
      yield* SynchronizedRef.update(disposers, (m) =>
        new Map(m).set(childSessionID, Fiber.interrupt(fiber)),
      )
      yield* Effect.addFinalizer(() =>
        Fiber.interrupt(fiber).pipe(
          Effect.andThen(
            SynchronizedRef.update(disposers, (m) => {
              const nm = new Map(m)
              nm.delete(childSessionID)
              return nm
            }),
          ),
        ),
      )
    })

  const startWatcherForChild: Interface["startWatcherForChild"] = (childSessionID) =>
    Effect.gen(function* () {
      const lastBeat = yield* SynchronizedRef.make(0)
      const fired = yield* SynchronizedRef.make(false)
      yield* eventBus.subscribe((e) =>
        Effect.gen(function* () {
          if (e._tag === "SubagentHeartbeat" && e.childSessionID === childSessionID) {
            yield* SynchronizedRef.set(lastBeat, e.timestamp)
          }
        }),
      )
      const check = Effect.gen(function* () {
        const last = yield* SynchronizedRef.get(lastBeat)
        const alreadyFired = yield* SynchronizedRef.get(fired)
        if (alreadyFired) return
        const now = yield* Effect.clockWith((c) => c.currentTimeMillis)
        if (now - last > HEARTBEAT_LOSS_TIMEOUT_MS) {
          yield* SynchronizedRef.set(fired, true)
          yield* eventBus.publish({ _tag: "SubagentHeartbeatLost", childSessionID })
        }
      })
      yield* check.pipe(Effect.repeat(Schedule.spaced(WATCHER_POLL_INTERVAL)), Effect.forkScoped)
    })

  const stopForChild: Interface["stopForChild"] = (childSessionID) =>
    Effect.gen(function* () {
      const d = yield* SynchronizedRef.get(disposers).pipe(Effect.map((m) => m.get(childSessionID)))
      if (d) yield* d
    })

  return { startForChild, startWatcherForChild, stopForChild }
})

export const startForChild = (
  childSessionID: string,
): Effect.Effect<void, never, Interface | EventBus.Interface | import("effect").Scope.Scope> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.startForChild(childSessionID)
  })

export const startWatcherForChild = (
  childSessionID: string,
): Effect.Effect<void, never, Interface | EventBus.Interface | import("effect").Scope.Scope> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.startWatcherForChild(childSessionID)
  })

export const stopForChild = (childSessionID: string): Effect.Effect<void, never, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.stopForChild(childSessionID)
  })

export const layerForTest: Layer.Layer<Interface, never, EventBus.Interface> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [EventBus.node] })
