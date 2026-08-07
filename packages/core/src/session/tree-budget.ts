export * as TreeBudget from "./tree-budget"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../effect/app-node"

/**
 * Optional full-tree token/cost budget for one session (parent + observed usage).
 * Default off: `limit === undefined` means unlimited.
 */
export interface Interface {
  /** Remaining tokens before stop; Infinity when unlimited. */
  readonly remaining: Effect.Effect<number>
  readonly limit: Effect.Effect<number | undefined>
  readonly setLimit: (limit: number | undefined) => Effect.Effect<void>
  readonly debit: (tokens: number) => Effect.Effect<{ readonly exhausted: boolean }>
  readonly reset: Effect.Effect<void>
}

export const Service = Context.Service<Interface>("@opencode/Session/TreeBudget")

export const make = (initialLimit?: number): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const limitRef = yield* SynchronizedRef.make<number | undefined>(initialLimit)
    const usedRef = yield* SynchronizedRef.make(0)

    const remaining: Interface["remaining"] = Effect.gen(function* () {
      const limit = yield* SynchronizedRef.get(limitRef)
      if (limit === undefined) return Number.POSITIVE_INFINITY
      const used = yield* SynchronizedRef.get(usedRef)
      return Math.max(0, limit - used)
    })

    const debit: Interface["debit"] = (tokens) =>
      Effect.gen(function* () {
        const limit = yield* SynchronizedRef.get(limitRef)
        if (limit === undefined) return { exhausted: false as const }
        const used = yield* SynchronizedRef.updateAndGet(usedRef, (n) => n + Math.max(0, tokens))
        return { exhausted: used >= limit }
      })

    return {
      remaining,
      limit: SynchronizedRef.get(limitRef),
      setLimit: (limit) =>
        Effect.gen(function* () {
          yield* SynchronizedRef.set(limitRef, limit)
          yield* SynchronizedRef.set(usedRef, 0)
        }),
      debit,
      reset: Effect.gen(function* () {
        yield* SynchronizedRef.set(usedRef, 0)
      }),
    } satisfies Interface
  })

export const layerForTest = (limit?: number): Layer.Layer<Interface> => Layer.effect(Service, make(limit))

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, make()),
  deps: [],
})
