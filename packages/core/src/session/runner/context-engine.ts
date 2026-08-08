export * as ContextEngine from "./context-engine"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { IterationBudget } from "../loop-control/iteration-budget"

/**
 * L4 ContextEngine — proactive context compaction trigger + last-compact tracker.
 *
 * `shouldProactiveCompact` returns true when budget used ≥ 50% AND at least
 * MIN_STEPS_BETWEEN_PROACTIVE_COMPACT steps have passed since the last compact.
 * This prevents over-compaction (two compacts back-to-back waste budget).
 *
 * `compact` records the current `consumed` count as `lastCompactStepsConsumed`
 * so the next `shouldProactiveCompact` check measures delta from this point.
 *
 * Trigger + last-compact tracker. The runner (`llm.ts`) dispatches real
 * compaction via `compactIfNeeded` when `shouldProactiveCompact` is true.
 *
 * References:
 *   docs/loop-design.md §轨道2 (aider repomap PageRank + cognition compressor LLM)
 *   hermes context_engine.py
 */

const PROACTIVE_COMPACT_RATIO = 0.5
const MIN_STEPS_BETWEEN_PROACTIVE_COMPACT = 30

export interface Interface {
  readonly shouldProactiveCompact: Effect.Effect<boolean>
  readonly compact: Effect.Effect<void>
}

export const Service = Context.Service<Interface>("@opencode/Runner/ContextEngine")

export const make: Effect.Effect<Interface, never, IterationBudget.Interface> = Effect.gen(function* () {
  const budget = yield* IterationBudget.Service
  const lastCompactConsumed = yield* SynchronizedRef.make(0)
  const svc: Interface = {
    shouldProactiveCompact: Effect.gen(function* () {
      const remaining = yield* budget.remaining
      const cap = yield* budget.currentCap
      const consumed = cap - remaining
      const usedRatio = cap > 0 ? consumed / cap : 0
      if (usedRatio < PROACTIVE_COMPACT_RATIO) return false
      const last = yield* SynchronizedRef.get(lastCompactConsumed)
      return consumed - last >= MIN_STEPS_BETWEEN_PROACTIVE_COMPACT
    }),
    compact: Effect.gen(function* () {
      const remaining = yield* budget.remaining
      const cap = yield* budget.currentCap
      const consumed = cap - remaining
      yield* SynchronizedRef.set(lastCompactConsumed, consumed)
    }),
  }
  return svc
})

export const shouldProactiveCompact: Effect.Effect<boolean, never, Interface | IterationBudget.Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.shouldProactiveCompact
})

export const compact: Effect.Effect<void, never, Interface | IterationBudget.Interface> = Effect.gen(function* () {
  const svc = yield* Service
  yield* svc.compact
})

export const layerForTest: Layer.Layer<Interface, never, IterationBudget.Interface> =
  Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [IterationBudget.node] })
