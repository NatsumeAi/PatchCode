export * as CircuitBreaker from "./circuit-breaker"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"

export const BreakerState = {
  Closed: "Closed",
  Open: "Open",
  HalfOpen: "HalfOpen",
} as const
export type BreakerState = (typeof BreakerState)[keyof typeof BreakerState]

export interface Interface {
  readonly state: Effect.Effect<BreakerState>
  readonly recordFailure: Effect.Effect<void>
  readonly recordSuccess: Effect.Effect<void>
  readonly reset: Effect.Effect<void>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/CircuitBreaker")

const DEFAULT_FAILURE_THRESHOLD = 5

export const make = (failureThreshold: number = DEFAULT_FAILURE_THRESHOLD): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<BreakerState>("Closed")
    const failures = yield* SynchronizedRef.make(0)

    const recordFailure: Interface["recordFailure"] = Effect.gen(function* () {
      const current = yield* SynchronizedRef.get(state)
      if (current === "Open") return
      const next = yield* SynchronizedRef.updateAndGet(failures, (n) => n + 1)
      if (next >= failureThreshold) yield* SynchronizedRef.set(state, "Open")
    })

    const recordSuccess: Interface["recordSuccess"] = Effect.gen(function* () {
      yield* SynchronizedRef.set(failures, 0)
      const current = yield* SynchronizedRef.get(state)
      if (current === "Open") yield* SynchronizedRef.set(state, "HalfOpen")
    })

    const reset: Interface["reset"] = Effect.gen(function* () {
      yield* SynchronizedRef.set(failures, 0)
      yield* SynchronizedRef.set(state, "Closed")
    })

    return {
      state: SynchronizedRef.get(state),
      recordFailure,
      recordSuccess,
      reset,
    }
  })

export const state: Effect.Effect<BreakerState, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.state
})

export const recordFailure: Effect.Effect<void, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  yield* svc.recordFailure
})

export const recordSuccess: Effect.Effect<void, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  yield* svc.recordSuccess
})

export const reset: Effect.Effect<void, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  yield* svc.reset
})

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make())

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make()), deps: [] })
