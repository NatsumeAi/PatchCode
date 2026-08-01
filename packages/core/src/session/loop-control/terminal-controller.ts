export * as TerminalController from "./terminal-controller"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"

/**
 * TerminalController is the single authority that decides when a loop drain has
 * stopped running and why. A verifier may report approval (verifier_approved),
 * but hard stops — explicit user abort, a boss-imposed hard timeout, an exhausted
 * budget, or an unrecoverable failure — overrule that soft approval. The first
 * accepted reason is recorded in the snapshot; a higher-precedence hard reason
 * that arrives later replaces it. Once terminal, the controller cannot return
 * to running by itself — only an explicit reset clears it for the next drain.
 *
 * The transition table is a small pure reducer (`reduce`) so precedence and
 * idempotence can be unit-tested without an LLM, filesystem, or fiber. The
 * service wrapper holds the snapshot in a `SynchronizedRef` so concurrent fibers
 * (verifier callback, timer daemon, budget guard) thread-safely reconcile.
 */

export const TerminalState = {
  running: "running",
  waiting: "waiting",
  terminated: "terminated",
  aborted: "aborted",
  budget_exhausted: "budget_exhausted",
  timed_out: "timed_out",
  failed: "failed",
} as const
export type TerminalState = (typeof TerminalState)[keyof typeof TerminalState]

export const TerminalReason = {
  verifier_approved: "verifier_approved",
  user_abort: "user_abort",
  hard_timeout: "hard_timeout",
  budget_exhausted: "budget_exhausted",
  unrecoverable_failure: "unrecoverable_failure",
} as const
export type TerminalReason = (typeof TerminalReason)[keyof typeof TerminalReason]

export interface TerminalSnapshot {
  readonly state: TerminalState
  readonly reason: TerminalReason | null
}

const INITIAL_SNAPSHOT: TerminalSnapshot = { state: "running", reason: null }

/**
 * Higher precedence wins. verifier_approved is soft (rank 0); hard reasons are
 * ranked so that human intent (user_abort) outranks mechanical stops, and a
 * hard stop outranks budget exhaustion, which outranks a generic failure.
 * Equal rank is idempotent (no-op).
 */
const rank: Record<TerminalReason, number> = {
  verifier_approved: 0,
  unrecoverable_failure: 1,
  budget_exhausted: 2,
  hard_timeout: 3,
  user_abort: 4,
}

const toState: Record<TerminalReason, TerminalState> = {
  verifier_approved: "terminated",
  user_abort: "aborted",
  hard_timeout: "timed_out",
  budget_exhausted: "budget_exhausted",
  unrecoverable_failure: "failed",
}

/**
 * Pure state machine. Decides the next snapshot from the current one and an
 * incoming reason. Rules:
 *  - running accepts any reason; the snapshot records the reason and its state.
 *  - waiting treats an incoming reason like running (still non-terminal).
 *  - terminal: a same-rank reason is idempotent; a strictly higher-rank hard
 *    reason overrides the accepted reason and rewrites the terminal state; an
 *    equal-or-lower-rank reason is ignored (terminal irreversibility).
 */
export const reduce =
  (prev: TerminalSnapshot, reason: TerminalReason): TerminalSnapshot => {
    const incoming = rank[reason]
    if (prev.state === "running" || prev.state === "waiting") {
      return { state: toState[reason], reason }
    }
    // terminal
    if (prev.reason === null) return prev // defensive: should not happen
    const current = rank[prev.reason]
    if (incoming > current) return { state: toState[reason], reason }
    return prev
  }

export interface Interface {
  readonly request: (reason: TerminalReason) => Effect.Effect<void>
  readonly shouldContinue: Effect.Effect<boolean>
  readonly snapshot: Effect.Effect<TerminalSnapshot>
  readonly reset: Effect.Effect<void>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/TerminalController")

export const make: Effect.Effect<Interface> = Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make<TerminalSnapshot>(INITIAL_SNAPSHOT)

  const request: Interface["request"] = (reason) =>
    SynchronizedRef.update(ref, (prev) => reduce(prev, reason))

  const shouldContinue: Interface["shouldContinue"] = Effect.gen(function* () {
    const snap = yield* SynchronizedRef.get(ref)
    return snap.state === "running" || snap.state === "waiting"
  })

  const snapshot: Interface["snapshot"] = SynchronizedRef.get(ref)

  const reset: Interface["reset"] = SynchronizedRef.set(ref, INITIAL_SNAPSHOT)

  return { request, shouldContinue, snapshot, reset }
})

export const request =
  (reason: TerminalReason): Effect.Effect<void, never, Interface> =>
    Effect.gen(function* () {
      const svc = yield* Service
      yield* svc.request(reason)
    })

export const shouldContinue: Effect.Effect<boolean, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.shouldContinue
})

export const snapshot: Effect.Effect<TerminalSnapshot, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.snapshot
})

export const reset: Effect.Effect<void, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  yield* svc.reset
})

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [] })
