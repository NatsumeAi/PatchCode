export * as LoopControlTracker from "./tracker"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { WorkerState } from "./worker-state"
import { EventBus } from "./event-bus"

export const LoopState = {
  Idle: "Idle",
  Running: "Running",
  Waiting: "Waiting",
  Paused: "Paused",
  HardStopped: "HardStopped",
} as const
export type LoopState = (typeof LoopState)[keyof typeof LoopState]

export interface Interface {
  readonly state: Effect.Effect<LoopState>
  readonly set: (state: LoopState) => Effect.Effect<void>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/LoopControlTracker")

export const make: Effect.Effect<Interface, never, WorkerState.Interface | EventBus.Interface> = Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make<LoopState>("Idle")
  const workerState = yield* WorkerState.Service
  yield* workerState.current
  const state: Interface["state"] = SynchronizedRef.get(ref)
  const set: Interface["set"] = (next) => SynchronizedRef.set(ref, next)
  return { state, set }
})

export const state: Effect.Effect<LoopState, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.state
})

export const set = (next: LoopState): Effect.Effect<void, never, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.set(next)
  })

export const layerForTest: Layer.Layer<Interface, never, WorkerState.Interface | EventBus.Interface> =
  Layer.effect(Service, make)

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, make),
  deps: [WorkerState.node, EventBus.node],
})
