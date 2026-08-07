export * as GoalStore from "./goal-store"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"

export type GoalSource = "empty" | "auto" | "explicit"

export interface Interface {
  readonly get: Effect.Effect<string>
  /** true when goal was set via set()/explicit /loop goal (verifier may run). */
  readonly isExplicit: Effect.Effect<boolean>
  readonly set: (goal: string) => Effect.Effect<void>
  /** Sets goal only when currently empty/whitespace. Returns true if a value was written. Auto source (display + status; soft verifier). */
  readonly setIfEmpty: (goal: string) => Effect.Effect<boolean>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/GoalStore")

const MAX_GOAL_CHARS = 2000

type State = { text: string; source: GoalSource }

export const make: Effect.Effect<Interface> = Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make<State>({ text: "", source: "empty" })
  const get: Interface["get"] = SynchronizedRef.get(ref).pipe(Effect.map((s) => s.text))
  const isExplicit: Interface["isExplicit"] = SynchronizedRef.get(ref).pipe(Effect.map((s) => s.source === "explicit"))
  const set: Interface["set"] = (goal) =>
    SynchronizedRef.set(ref, { text: goal.trim().slice(0, MAX_GOAL_CHARS), source: "explicit" })
  const setIfEmpty: Interface["setIfEmpty"] = (goal) =>
    SynchronizedRef.modify(ref, (cur) => {
      if (cur.text.trim().length > 0) return [false, cur] as const
      const next = goal.trim().slice(0, MAX_GOAL_CHARS)
      if (next.length === 0) return [false, cur] as const
      return [true, { text: next, source: "auto" as const }] as const
    })
  return { get, isExplicit, set, setIfEmpty }
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

export const setIfEmpty = (goal: string): Effect.Effect<boolean, never, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    return yield* svc.setIfEmpty(goal)
  })

export const isExplicit: Effect.Effect<boolean, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.isExplicit
})

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [] })
