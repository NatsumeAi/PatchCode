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
  /** Optional provider-keyed variants (W2). Default key is `"default"`. */
  readonly stateFor: (key: string) => Effect.Effect<BreakerState>
  readonly recordFailureFor: (key: string) => Effect.Effect<void>
  readonly recordSuccessFor: (key: string) => Effect.Effect<void>
  readonly resetFor: (key: string) => Effect.Effect<void>
  /** True when a request for this provider may proceed (Closed, or HalfOpen probe). */
  readonly allowRequest: (key?: string) => Effect.Effect<boolean>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/CircuitBreaker")

const DEFAULT_FAILURE_THRESHOLD = 5
const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_COOLDOWN_MS = 30_000
const DEFAULT_KEY = "default"

type Bucket = {
  state: BreakerState
  /** Failure timestamps in the sliding window. */
  failures: number[]
  openedAt: number
  /** When a HalfOpen probe is in flight (cancel-safe reclaim after cooldown). */
  probeClaimedAt: number | undefined
}

const emptyBucket = (): Bucket => ({
  state: "Closed",
  failures: [],
  openedAt: 0,
  probeClaimedAt: undefined,
})

export const make = (
  failureThreshold: number = DEFAULT_FAILURE_THRESHOLD,
  options?: { windowMs?: number; cooldownMs?: number; enabled?: boolean },
): Effect.Effect<Interface> =>
  Effect.gen(function* () {
    // Default off: production construction stays a no-op unless explicitly enabled
    // (plan: do not change existing drain behavior). Tests pass { enabled: true }.
    const enabled = options?.enabled === true
    const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS
    const cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS
    const buckets = yield* SynchronizedRef.make(new Map<string, Bucket>())

    const getBucket = (map: Map<string, Bucket>, key: string): Bucket => map.get(key) ?? emptyBucket()

    const prune = (b: Bucket, now: number): Bucket => ({
      ...b,
      failures: b.failures.filter((t) => now - t < windowMs),
    })

    const recordFailureFor = (key: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!enabled) return
        const now = Date.now()
        yield* SynchronizedRef.update(buckets, (map) => {
          const next = new Map(map)
          let b = prune(getBucket(next, key), now)
          if (b.state === "Open") {
            // Failed probe or additional failure while open: stay open, refresh cooldown.
            b = { ...b, state: "Open", openedAt: now, probeClaimedAt: undefined }
          } else if (b.state === "HalfOpen") {
            b = { ...b, state: "Open", openedAt: now, probeClaimedAt: undefined, failures: [...b.failures, now] }
          } else {
            const failures = [...b.failures, now]
            b =
              failures.length >= failureThreshold
                ? { ...b, state: "Open", openedAt: now, failures, probeClaimedAt: undefined }
                : { ...b, failures }
          }
          next.set(key, b)
          return next
        })
      })

    const recordSuccessFor = (key: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!enabled) return
        yield* SynchronizedRef.update(buckets, (map) => {
          const next = new Map(map)
          const b = getBucket(next, key)
          // Probe or normal success → fully closed.
          next.set(key, { state: "Closed", failures: [], openedAt: 0, probeClaimedAt: undefined })
          void b
          return next
        })
      })

    const stateFor = (key: string): Effect.Effect<BreakerState> =>
      Effect.gen(function* () {
        if (!enabled) return "Closed" as const
        const now = Date.now()
        const map = yield* SynchronizedRef.get(buckets)
        let b = prune(getBucket(map, key), now)
        // Cooldown elapsed → allow half-open (probe slot).
        if (b.state === "Open" && now - b.openedAt >= cooldownMs) {
          b = { ...b, state: "HalfOpen", probeClaimedAt: undefined }
          yield* SynchronizedRef.update(buckets, (m) => new Map(m).set(key, b))
        }
        // Stale probe claim: reclaim after another cooldown so cancel-safe.
        if (b.state === "HalfOpen" && b.probeClaimedAt !== undefined && now - b.probeClaimedAt >= cooldownMs) {
          b = { ...b, probeClaimedAt: undefined }
          yield* SynchronizedRef.update(buckets, (m) => new Map(m).set(key, b))
        }
        return b.state
      })

    const allowRequest = (key: string = DEFAULT_KEY): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (!enabled) return true
        const now = Date.now()
        const st = yield* stateFor(key)
        if (st === "Closed") return true
        if (st === "Open") return false
        // HalfOpen: single probe slot.
        return yield* SynchronizedRef.modify(buckets, (map) => {
          const next = new Map(map)
          const b = getBucket(next, key)
          if (b.state !== "HalfOpen") return [false, next] as const
          if (b.probeClaimedAt !== undefined) return [false, next] as const
          next.set(key, { ...b, probeClaimedAt: now })
          return [true, next] as const
        })
      })

    const resetFor = (key: string): Effect.Effect<void> =>
      SynchronizedRef.update(buckets, (map) => new Map(map).set(key, emptyBucket()))

    return {
      state: stateFor(DEFAULT_KEY),
      recordFailure: recordFailureFor(DEFAULT_KEY),
      recordSuccess: recordSuccessFor(DEFAULT_KEY),
      reset: resetFor(DEFAULT_KEY),
      stateFor,
      recordFailureFor,
      recordSuccessFor,
      resetFor,
      allowRequest,
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

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make(DEFAULT_FAILURE_THRESHOLD, { enabled: true }))

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make()), deps: [] })
