export * as WorkerState from "./worker-state"

import { Context, Effect, Layer, Schema, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"

/**
 * WorkerState is the loop-control state machine for one worker fiber inside the session
 * runner. It tracks the worker's current operating state (Active / Waiting(reason) / Dead(reason))
 * and the derived harness observation (Busy / Idle / Stuck).
 *
 * Allowed transitions (verified, not arbitrary):
 *   Active  → Waiting(reason)    — harness explicitly pauses worker
 *   Waiting → Active              — harness resumes worker (callback completion etc.)
 *   Waiting → Waiting(otherReason) — same-named transition permitted (waiting 內部状态切换, e.g. OnChild→OnForegroundExec)
 *   *       → Dead(reason)        — harness kills worker (no-heartbeat, exhausted grace, parent abort)
 *   Dead    → *                   — REJECTED — Dead is terminal; whole session must HardAbort.
 *
 * Reference: docs/loop-design.md §3.2 worker 三态; Plan 2 Task 2 brief.
 */

export const WaitingReason = Schema.Literals([
  "OnChild",
  "OnForegroundExec",
  "OnBackgroundExec",
])
export type WaitingReason = Schema.Schema.Type<typeof WaitingReason>

export const DeadReason = Schema.Literals([
  "NoHeartbeatN",
  "GraceCalledThenExhausted",
  "ParentAbort",
])
export type DeadReason = Schema.Schema.Type<typeof DeadReason>

export const WorkerStateValue = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Active") }),
  Schema.Struct({ _tag: Schema.Literal("Waiting"), reason: WaitingReason }),
  Schema.Struct({ _tag: Schema.Literal("Dead"), reason: DeadReason }),
])
export type WorkerStateValue = Schema.Schema.Type<typeof WorkerStateValue>

export const HarnessState = Schema.Literals(["Busy", "Idle", "Stuck"])
export type HarnessState = Schema.Schema.Type<typeof HarnessState>

export class InvalidTransition extends Schema.TaggedErrorClass<InvalidTransition>()(
  "LoopControl.WorkerState.InvalidTransition",
  { from: WorkerStateValue, to: WorkerStateValue },
) {}

const isAllowed = (from: WorkerStateValue, to: WorkerStateValue): boolean => {
  if (from._tag === "Dead") return false
  if (from._tag === to._tag) {
    if (from._tag === "Active") return true
    if (from._tag === "Waiting") return true
    return false
  }
  return true
}

const mapHarness = (w: WorkerStateValue): HarnessState =>
  w._tag === "Active" ? "Busy" : w._tag === "Waiting" ? "Idle" : "Stuck"

export interface Interface {
  readonly transition: (to: WorkerStateValue) => Effect.Effect<void, InvalidTransition>
  /**
   * Force-sets the state to Active for an intentional new drain, bypassing the
   * transition table. Required because the table rejects Dead → Active (Dead is
   * terminal for the run that owned the worker), but a later drain reuses the
   * same per-session bundle via `SessionRuntime.resetForDrain` and needs a
   * fresh worker. Do NOT use this for ordinary harness transitions — `transition`
   * is the runtime path; `reset` is the lifecycle path.
   */
  readonly reset: Effect.Effect<void>
  readonly current: Effect.Effect<WorkerStateValue>
  readonly currentHarness: Effect.Effect<HarnessState>
  readonly isBusy: Effect.Effect<boolean>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/WorkerState")

export const make: Effect.Effect<Interface> = Effect.gen(function* () {
  const state = yield* SynchronizedRef.make<WorkerStateValue>({ _tag: "Active" })

  const transition: Interface["transition"] = (to) =>
    Effect.gen(function* () {
      yield* SynchronizedRef.updateEffect(state, (from) =>
        Effect.gen(function* () {
          if (!isAllowed(from, to)) {
            yield* Effect.fail(new InvalidTransition({ from, to }))
          }
          return to
        }),
      )
    })

  const current: Interface["current"] = SynchronizedRef.modify(state, (s) => [s, s])

  const reset: Interface["reset"] = SynchronizedRef.set(state, { _tag: "Active" })

  const currentHarness: Interface["currentHarness"] = Effect.gen(function* () {
    const c = yield* current
    return mapHarness(c)
  })

  const isBusy: Interface["isBusy"] = Effect.gen(function* () {
    const h = yield* currentHarness
    return h === "Busy"
  })

  return { transition, reset, current, currentHarness, isBusy }
})

export const transition = (to: WorkerStateValue): Effect.Effect<void, InvalidTransition, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.transition(to)
  })

export const reset: Effect.Effect<void, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  yield* svc.reset
})

export const current: Effect.Effect<WorkerStateValue, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.current
})

export const currentHarness: Effect.Effect<HarnessState, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.currentHarness
})

export const isBusy: Effect.Effect<boolean, never, Interface> = Effect.gen(function* () {
  const svc = yield* Service
  return yield* svc.isBusy
})

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [] })
