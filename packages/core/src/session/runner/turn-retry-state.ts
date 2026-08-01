export * as TurnRetryState from "./turn-retry-state"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"

/**
 * TurnRetryState — 19-class one-shot registry for in-turn failover dedup.
 *
 * `consume(reason)` returns true exactly once per reason per turn; second call
 * is false. Prevents infinite retry loops where the same error class triggers
 * the same retry path repeatedly.
 *
 * `reset` clears all one-shot flags (called at the start of each provider turn
 * by the runner hook in Plan 2 Task 7).
 *
 * Aligned with hermes `turn_retry_state.py:30-60` (19 one-shot booleans by
 * reason name). Per AGENTS.md, uses the function-form `Context.Service` like
 * Tasks 1/2/4 rather than the 2-stage class form, for consistency with the
 * completed loop-control modules.
 */

export interface Interface {
  readonly consume: (reason: string) => Effect.Effect<boolean>
  readonly reset: Effect.Effect<void>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/TurnRetryState")

export const make: Effect.Effect<Interface> = Effect.gen(function* () {
  const consumed = yield* SynchronizedRef.make(new Set<string>())

  const consume: Interface["consume"] = (reason) =>
    SynchronizedRef.modifyEffect(consumed, (s) =>
      Effect.gen(function* () {
        if (s.has(reason)) return [false, s] as const
        const ns = new Set(s)
        ns.add(reason)
        return [true, ns] as const
      }),
    )

  const reset: Interface["reset"] = SynchronizedRef.set(consumed, new Set())

  return { consume, reset }
})

export const consume = (reason: string): Effect.Effect<boolean, never, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    return yield* svc.consume(reason)
  })

export const reset: Effect.Effect<void, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  yield* svc.reset
})

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [] })
