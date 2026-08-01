export * as IterationBudget from "./iteration-budget"

import { Context, Effect, Layer, Schema, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"

/**
 * IterationBudget caps the iteration count of a long-running agent loop
 * (the opencode v2 session runner). The budget is set up once per session-drain
 * scope and may be consumed / refunded thread-safely from any fiber via
 * Effect.SynchronizedRef.
 *
 * The budget is intentionally non-durable: it lives for the duration of the owning
 * scope and resets on reload. Durable cap enforcement belongs to the session
 * admission layer, not here.
 *
 * Reference: docs/loop-design.md §5 iteration budget; hermes-agent/agent/iteration_budget.py
 * (parent cap 90 / child cap 50, _lock-guarded consume/refund).
 */

const DEFAULT_PARENT_CAP = 90
const DEFAULT_CHILD_CAP = 50
const DEFAULT_ACTIVE_CAP = 4

type BudgetState = {
  readonly cap: number
  consumed: number
}

export class InvalidCap extends Schema.TaggedErrorClass<InvalidCap>()(
  "LoopControl.IterationBudget.InvalidCap",
  { cap: Schema.Number },
) {
  override get message() {
    return `Invalid iteration budget cap: ${this.cap} (must be a positive finite number)`
  }
}

export class BudgetExhausted extends Schema.TaggedErrorClass<BudgetExhausted>()(
  "LoopControl.IterationBudget.BudgetExhausted",
  { remaining: Schema.Number },
) {}

export class ActiveAgentExceeded extends Schema.TaggedErrorClass<ActiveAgentExceeded>()(
  "LoopControl.IterationBudget.ActiveAgentExceeded",
  { active: Schema.Number, cap: Schema.Number },
) {}

export interface AgentGuard {
  readonly release: Effect.Effect<void>
}

export interface Interface {
  readonly consume: (amount: number) => Effect.Effect<void, BudgetExhausted>
  readonly refund: (amount: number) => Effect.Effect<void>
  readonly remaining: Effect.Effect<number>
  readonly isExhausted: Effect.Effect<boolean>
  readonly useGrace: Effect.Effect<boolean>
  readonly acquireAgentGuard: Effect.Effect<AgentGuard, ActiveAgentExceeded>
  readonly activeAgents: Effect.Effect<number>
  readonly cap: number
  readonly activeCap: number
  readonly currentCap: Effect.Effect<number>
  readonly setCap: (cap: number) => Effect.Effect<void, InvalidCap>
  readonly reset: () => Effect.Effect<void>
}

/**
 * Function-style service key (effect v4 canonical for services without inheritance
 * hierarchies). Yielding the key asks the environment for the service instance.
 */
export const Service = Context.Service<Interface>("@opencode/LoopControl/IterationBudget")

const validateCap = (cap: number): number => {
  if (!Number.isFinite(cap) || cap <= 0) throw new InvalidCap({ cap })
  return cap
}

export const make = (cap: number, activeCap: number = DEFAULT_ACTIVE_CAP): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    validateCap(cap)
    const state: BudgetState = { cap, consumed: 0 }
    const ref = yield* SynchronizedRef.make(state)
    const activeRef = yield* SynchronizedRef.make(0)
    const graceRef = yield* SynchronizedRef.make(false)

    const consume: Interface["consume"] = (amount) =>
      Effect.gen(function* () {
        yield* SynchronizedRef.updateEffect(ref, (s) =>
          Effect.gen(function* () {
            if (s.consumed + amount > s.cap) {
              yield* Effect.fail(new BudgetExhausted({ remaining: s.cap - s.consumed }))
            }
            return { ...s, consumed: s.consumed + amount }
          }),
        )
      })

    const refund: Interface["refund"] = (amount) =>
      SynchronizedRef.update(ref, (s) => ({
        ...s,
        consumed: Math.max(0, s.consumed - amount),
      }))

    const remaining: Interface["remaining"] = SynchronizedRef.modify(ref, (s) => [
      s.cap - s.consumed,
      s,
    ])

    const isExhausted: Interface["isExhausted"] = Effect.gen(function* () {
      const r = yield* remaining
      return r <= 0
    })

    const useGrace: Interface["useGrace"] = SynchronizedRef.modify(graceRef, (used) => [!used, true])

    const acquireAgentGuard: Interface["acquireAgentGuard"] = Effect.gen(function* () {
      yield* SynchronizedRef.updateEffect(activeRef, (n) =>
        Effect.gen(function* () {
          if (n >= activeCap) {
            yield* Effect.fail(new ActiveAgentExceeded({ active: n, cap: activeCap }))
          }
          return n + 1
        }),
      )
      const released = yield* SynchronizedRef.make(false)
      const release: AgentGuard["release"] = SynchronizedRef.updateEffect(released, (wasReleased) =>
        Effect.gen(function* () {
          if (wasReleased) return wasReleased
          yield* SynchronizedRef.update(activeRef, (n) => Math.max(0, n - 1))
          return true
        }),
      )
      return { release }
    })

    const activeAgents: Interface["activeAgents"] = SynchronizedRef.get(activeRef)

    const currentCap: Interface["currentCap"] = SynchronizedRef.modify(ref, (s) => [s.cap, s])

    const setCap: Interface["setCap"] = (cap) =>
      Effect.gen(function* () {
        validateCap(cap)
        yield* SynchronizedRef.updateEffect(ref, (s) =>
          Effect.gen(function* () {
            if (cap < s.consumed) yield* Effect.fail(new InvalidCap({ cap }))
            return { ...s, cap }
          }),
        )
      })

    const reset: Interface["reset"] = () =>
      Effect.gen(function* () {
        yield* SynchronizedRef.update(ref, (s) => ({ ...s, consumed: 0 }))
        yield* SynchronizedRef.set(graceRef, false)
      })

    return {
      consume,
      refund,
      remaining,
      isExhausted,
      useGrace,
      acquireAgentGuard,
      activeAgents,
      cap,
      activeCap,
      currentCap,
      setCap,
      reset,
    }
  })

/**
 * Accessor effects — pull the active service from the environment, then call its
 * method. Lets callers write `yield* IterationBudget.consume(1)` instead of
 * `yield* (yield* Service).consume(1)`.
 */
export const consume = (amount: number): Effect.Effect<void, BudgetExhausted, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.consume(amount)
  })

export const refund = (amount: number): Effect.Effect<void, never, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.refund(amount)
  })

export const remaining: Effect.Effect<number, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.remaining
})

export const isExhausted: Effect.Effect<boolean, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.isExhausted
})

export const useGrace: Effect.Effect<boolean, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.useGrace
})

export const acquireAgentGuard: Effect.Effect<AgentGuard, ActiveAgentExceeded, Interface> =
  Effect.gen(function* () {
    const svc = yield* Service
    return yield* svc.acquireAgentGuard
  })

export const activeAgents: Effect.Effect<number, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.activeAgents
})

export const currentCap: Effect.Effect<number, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.currentCap
})

export const setCap = (cap: number): Effect.Effect<void, InvalidCap, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.setCap(cap)
  })

export const reset = (): Effect.Effect<void, never, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.reset()
  })

export const layerForTest = (cap: number, activeCap: number = DEFAULT_ACTIVE_CAP): Layer.Layer<Interface> =>
  Layer.effect(Service, make(cap, activeCap))

export const layerParentDefault: Layer.Layer<Interface> = layerForTest(DEFAULT_PARENT_CAP)

export const layerChildDefault: Layer.Layer<Interface> = layerForTest(DEFAULT_CHILD_CAP)

export const node = makeGlobalNode({ service: Service, layer: layerForTest(DEFAULT_PARENT_CAP), deps: [] })

export const defaultParentCap = DEFAULT_PARENT_CAP
export const defaultChildCap = DEFAULT_CHILD_CAP
