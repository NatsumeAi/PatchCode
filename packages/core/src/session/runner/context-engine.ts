export * as ContextEngine from "./context-engine"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"

/**
 * Token-based proactive compaction trigger. Iteration step ratios are not used.
 * `setUsage` records the last turn's estimated tokens vs the model context window.
 * Compact fires when tokens ≥ window − min(10% window, 20_000). No usage yet → false.
 */

export type UsageSnapshot = {
  readonly tokens: number
  readonly window: number
}

export interface Interface {
  readonly setUsage: (input: UsageSnapshot) => Effect.Effect<void>
  readonly shouldProactiveCompact: Effect.Effect<boolean>
  readonly compact: Effect.Effect<void>
}

export const Service = Context.Service<Interface>("@opencode/Runner/ContextEngine")

export const bufferFor = (window: number) => Math.min(Math.floor(Math.max(0, window) * 0.1), 20_000)

export const make: Effect.Effect<Interface> = Effect.gen(function* () {
  const usage = yield* SynchronizedRef.make<UsageSnapshot | undefined>(undefined)
  const compacted = yield* SynchronizedRef.make(false)
  const svc: Interface = {
    setUsage: (input) => SynchronizedRef.set(usage, input),
    shouldProactiveCompact: Effect.gen(function* () {
      if (yield* SynchronizedRef.get(compacted)) return false
      const snap = yield* SynchronizedRef.get(usage)
      if (!snap || snap.window <= 0) return false
      return snap.tokens >= snap.window - bufferFor(snap.window)
    }),
    compact: SynchronizedRef.set(compacted, true),
  }
  return svc
})

export const shouldProactiveCompact: Effect.Effect<boolean, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.shouldProactiveCompact
})

export const compact: Effect.Effect<void, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  yield* svc.compact
})

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [] })
