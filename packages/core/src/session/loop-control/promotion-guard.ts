export * as PromotionGuard from "./promotion-guard"

import { Context, Deferred, Duration, Effect, Layer, Schema, SynchronizedRef } from "effect"

/**
 * §8e-2/3 fix — promotion wait timeout + atomic double-promote guard
 * (Plan 3 Task 5).
 *
 * Problem (docs/loop-design.md §8e 问题 2/3):
 *  - 问题 2: `background-job.ts waitForPromotion` had no timeout; a network
 *    blip or offline client would hang the parent session forever.
 *  - 问题 3: Multi-notify race relied on `SynchronizedRef`'s implicit
 *    serialization; a refactor that swapped `modifyEffect` for `bulk`/
 *    `parallel` would silently break the atomic double-promote invariant.
 *
 * Fix:
 *  - `waitForPromotion({ jobID, timeoutMs })` races the wait against a
 *    `Duration.millis(timeoutMs)` timeout. On timeout it returns
 *    `{ _tag: "Timeout" }` so the caller can break the loop instead of
 *    hanging. If the job was already promoted, the fast path returns
 *    `{ _tag: "Success", value: payload }` immediately.
 *  - `promote({ jobID, payload })` uses `SynchronizedRef.modifyEffect`
 *    with an explicit `if (m.has(jobID)) fail(DoublePromotion)` check
 *    inside the atomic block — the atomic invariant is syntactically
 *    obvious and survives refactors that change scheduling semantics.
 *
 * Per AGENTS.md: "Avoid using the `any` type" — the waiter registry uses
 * a typed callback shape, not `any`.
 */

export class DoublePromotion extends Schema.TaggedErrorClass<DoublePromotion>()(
  "LoopControl.PromotionGuard.DoublePromotion",
  { jobID: Schema.String },
) {}

export type PromotionOutcome =
  | { readonly _tag: "Success"; readonly value: unknown }
  | { readonly _tag: "Timeout" }

interface PromotionEntry {
  readonly payload: unknown
  readonly timestamp: number
}

export interface Interface {
  readonly waitForPromotion: (
    input: { jobID: string; timeoutMs: number },
  ) => Effect.Effect<PromotionOutcome>
  readonly promote: (
    input: { jobID: string; payload: unknown },
  ) => Effect.Effect<void, DoublePromotion>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/PromotionGuard")

export const make: Effect.Effect<Interface> = Effect.gen(function* () {
  const promotions = yield* SynchronizedRef.make(new Map<string, PromotionEntry>())
  const waiters = yield* SynchronizedRef.make(new Map<string, Deferred.Deferred<unknown>[]>())

  const waitForPromotion: Interface["waitForPromotion"] = ({ jobID, timeoutMs }) =>
    Effect.gen(function* () {
      const existing = yield* SynchronizedRef.get(promotions).pipe(Effect.map((m) => m.get(jobID)))
      if (existing !== undefined) {
        return { _tag: "Success" as const, value: existing.payload }
      }

      const deferred = yield* Deferred.make<unknown>()
      yield* SynchronizedRef.modifyEffect(waiters, (w) =>
        Effect.gen(function* () {
          const already = (yield* SynchronizedRef.get(promotions)).get(jobID)
          if (already !== undefined) {
            yield* Deferred.succeed(deferred, already.payload)
            return [undefined, w] as const
          }
          const list = w.get(jobID) ?? []
          return [undefined, new Map(w).set(jobID, [...list, deferred])] as const
        }),
      )

      const result = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)))
      if (result._tag === "Some") {
        return { _tag: "Success" as const, value: result.value }
      }
      return { _tag: "Timeout" as const }
    })

  const promote: Interface["promote"] = ({ jobID, payload }) =>
    Effect.gen(function* () {
      yield* SynchronizedRef.modifyEffect(promotions, (m) =>
        Effect.gen(function* () {
          if (m.has(jobID)) {
            yield* Effect.fail(new DoublePromotion({ jobID }))
          }
          const nm = new Map(m).set(jobID, { payload, timestamp: Date.now() })
          return [undefined, nm] as const
        }),
      )
      const list = yield* SynchronizedRef.modify(waiters, (w) => {
        const l = w.get(jobID) ?? []
        const nm = new Map(w)
        nm.delete(jobID)
        return [l, nm] as const
      })
      for (const deferred of list) {
        yield* Deferred.succeed(deferred, payload).pipe(Effect.ignore)
      }
    })

  return { waitForPromotion, promote }
})

export const waitForPromotion = (
  input: { jobID: string; timeoutMs: number },
): Effect.Effect<PromotionOutcome, never, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    return yield* svc.waitForPromotion(input)
  })

export const promote = (
  input: { jobID: string; payload: unknown },
): Effect.Effect<void, DoublePromotion, Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.promote(input)
  })

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make)
