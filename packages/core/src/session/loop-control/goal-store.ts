export * as GoalStore from "./goal-store"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"

export interface Interface {
  readonly get: Effect.Effect<string>
  readonly set: (goal: string) => Effect.Effect<void>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/GoalStore")

export const make: Effect.Effect<Interface> = Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make("")
  const get: Interface["get"] = SynchronizedRef.get(ref)
  const set: Interface["set"] = (goal) => SynchronizedRef.update(ref, () => goal)
  return { get, set }
})

export const get: Effect.Effect<string, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.get
})

export const set = (goal: string): Effect.Effect<void, never, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.set(goal)
  })

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [] })
