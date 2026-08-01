export * as EventBus from "./event-bus"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { Schema } from "effect"
import { makeGlobalNode } from "../../effect/app-node"

/**
 * LoopControl EventBus — process-local, non-durable pub/sub for 8机关 internal events.
 *
 * Not durable. Never writes to SessionInputTable / SessionMessageTable / transcript.
 * Lives for the owning session-scope; reload loses it. The durable admission path
 * (SessionV2.prompt) is separate and must not be conflated with this bus.
 *
 * Events emitted by the loop-control runtime:
 *   ① HeartbeatTick                  — Timer. Throws no-op while worker is Busy (mask).
 *   ③ StopReminder                   — Timer. Fires only when worker is Busy.
 *   ⑤ WaitIdleBackupTick             — Timer. Fires only when worker is Idle.
 *   Null                             — Timer ② placeholder (loop over time, not terminate).
 *   LoopTerminated                   — Timer ② boss ceiling reached.
 *   SubagentCompleted                — subagent fork completes (Task 5+).
 *   BackgroundJobDone                — background tool job done (Task 6).
 *   HardAbort                        — any 机关 triggers hard abort.
 *
 * Dispatch is synchronous on the publisher's fiber. Subscribers run inline; a slow
 * subscriber blocks the publisher. This is intentional for the loop-control domain —
 * the runtime must observe delivery order and fail-stop on subscriber error. A durable
 * queue with its own session-scoped worker pool is out of scope for this layer.
 *
 * Reference: docs/loop-design.md §3.3 timer 适用矩阵; Plan 2 Task 4 brief.
 */

export const LoopControlEvent = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("HeartbeatTick"), time: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("StopReminder"), reason: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("WaitIdleBackupTick"), reason: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Null") }),
  Schema.Struct({ _tag: Schema.Literal("LoopTerminated"), reason: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("SubagentCompleted"),
    parentSessionID: Schema.String,
    childSessionID: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("SubagentFailed"),
    parentSessionID: Schema.String,
    childSessionID: Schema.String,
    error: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.Literal("BackgroundJobDone"), jobID: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("HardAbort"), reason: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("VerifierRejectInjected"), reason: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal("SubagentHeartbeat"),
    childSessionID: Schema.String,
    timestamp: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("SubagentHeartbeatLost"), childSessionID: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("AbortRequested"), source: Schema.String, at: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("HookTurnStart"), sessionID: Schema.String, step: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal("HookToolCall"), sessionID: Schema.String, name: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("HookTurnEnd"), sessionID: Schema.String }),
])
export type LoopControlEvent = Schema.Schema.Type<typeof LoopControlEvent>

export type Subscriber = (event: LoopControlEvent) => Effect.Effect<void>

type Registry = {
  readonly subs: Map<number, Subscriber>
  nextID: number
}

export interface Interface {
  readonly publish: (event: LoopControlEvent) => Effect.Effect<void>
  readonly subscribe: (sub: Subscriber) => Effect.Effect<Effect.Effect<void>>
  readonly shutdown: Effect.Effect<void>
  readonly snapshotBuffer: (limit: number) => Effect.Effect<LoopControlEvent[]>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/EventBus")

const SNAPSHOT_CAP = 100

export const make: Effect.Effect<Interface> = Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make({ subs: new Map<number, Subscriber>(), nextID: 0 })
  const snapshot = yield* SynchronizedRef.make<LoopControlEvent[]>([])

  const publish = (event: LoopControlEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* SynchronizedRef.update(snapshot, (buf) => {
        const next = [...buf, event]
        return next.length > SNAPSHOT_CAP ? next.slice(next.length - SNAPSHOT_CAP) : next
      })
      const reg = yield* SynchronizedRef.get(ref)
      const handlers: Subscriber[] = Array.from(reg.subs.values())
      for (const s of handlers) yield* s(event)
    })

  const subscribe = (
    sub: Subscriber,
  ): Effect.Effect<Effect.Effect<void>> =>
    Effect.gen(function* () {
      const id = yield* SynchronizedRef.modify(ref, (r): readonly [number, Registry] => {
        const nextID = r.nextID + 1
        const subs = new Map(r.subs).set(nextID, sub)
        return [nextID, { subs, nextID }]
      })
      return Effect.gen(function* () {
        yield* SynchronizedRef.update(ref, (r) => {
          const subs = new Map(r.subs)
          subs.delete(id)
          return { subs, nextID: r.nextID }
        })
      })
    })

  const shutdown: Effect.Effect<void> = Effect.void

  const snapshotBuffer: Interface["snapshotBuffer"] = (limit) =>
    SynchronizedRef.modify(snapshot, (buf) => [buf.slice(-limit), buf])

  return { publish, subscribe, shutdown, snapshotBuffer }
})

export const publish = (event: LoopControlEvent): Effect.Effect<void, never, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.publish(event)
  })

export const subscribe = (
  sub: Subscriber,
): Effect.Effect<Effect.Effect<void>, never, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    return yield* svc.subscribe(sub)
  })

export const shutdown: Effect.Effect<void, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  yield* svc.shutdown
})

export const snapshotBuffer = (
  limit: number,
): Effect.Effect<LoopControlEvent[], never, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    return yield* svc.snapshotBuffer(limit)
  })

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [] })
