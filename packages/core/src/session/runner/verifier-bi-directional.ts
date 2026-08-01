export * as VerifierBiDirectional from "./verifier-bi-directional"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { EventBus } from "../loop-control/event-bus"
import { makeGlobalNode } from "../../effect/app-node"
import type { VerifierResponse } from "./verifier"

/**
 * L3 Verifier ↔ worker bi-directional channel (Plan 3 Task 2).
 *
 * `injectRejectReasonToWorkerContext(reason, evidence?)` pushes a verified
 * reject reason into a per-loop queue AND publishes `VerifierRejectInjected`
 * on the loop-control EventBus for harness observation.
 *
 * `getNextTurnSystemContext` drains BOTH queues atomically with the returned
 * value: the reason and evidence captured in one drain are exactly what the
 * next turn sees, and a second drain returns empty reason and empty evidence.
 * The worker harness folds the drained feedback into the next provider turn's
 * system context, so the worker sees the verifier feedback without it
 * polluting the durable transcript (per design rationale §8 变更日志).
 */
export interface NextTurnSystemContext {
  readonly verifier_reject_reason: string
  readonly verifier_reject_evidence: ReadonlyArray<{ file: string; line?: number; issue: string }>
}

type Evidence = NonNullable<VerifierResponse["evidence"]>

export interface Interface {
  readonly injectRejectReasonToWorkerContext: (
    reason: string,
    evidence?: Evidence,
  ) => Effect.Effect<void, never, EventBus.Interface>
  readonly getNextTurnSystemContext: Effect.Effect<NextTurnSystemContext>
}

export const Service = Context.Service<Interface>("@opencode/Runner/VerifierBiDirectional")

/**
 * Pending rejection feedback: reasons and evidence captured together in one
 * mutable record so an inject and a drain are each a single atomic step.
 * Two separate refs would allow a concurrent inject to interleave between the
 * reason drain and the evidence drain, losing or duplicating feedback across
 * turns.
 */
type Feedback = {
  readonly reasons: ReadonlyArray<string>
  readonly evidence: Evidence
}

const emptyFeedback: Feedback = { reasons: [], evidence: [] }

export const make: Effect.Effect<Interface, never, EventBus.Interface> = Effect.gen(function* () {
  const feedback = yield* SynchronizedRef.make<Feedback>(emptyFeedback)

  const injectRejectReasonToWorkerContext: Interface["injectRejectReasonToWorkerContext"] = (
    reason,
    evidence,
  ) =>
    Effect.gen(function* () {
      yield* SynchronizedRef.update(feedback, (f) => ({
        reasons: [...f.reasons, reason],
        ...(evidence && evidence.length > 0
          ? { evidence: [...f.evidence, ...evidence] }
          : { evidence: f.evidence }),
      }))
      yield* EventBus.publish({ _tag: "VerifierRejectInjected", reason })
    })

  const getNextTurnSystemContext: Interface["getNextTurnSystemContext"] = Effect.gen(function* () {
    // One modify swaps the captured feedback out for empty in the same step,
    // so a second drain always returns empty reason + empty evidence.
    const { reasons, evidence } = yield* SynchronizedRef.modify(
      feedback,
      (f): readonly [Feedback, Feedback] => [f, emptyFeedback],
    )
    return {
      verifier_reject_reason: reasons.length > 0 ? reasons.join("\n") : "",
      verifier_reject_evidence: evidence,
    }
  })

  return { injectRejectReasonToWorkerContext, getNextTurnSystemContext }
})

export const injectRejectReasonToWorkerContext = (
  reason: string,
  evidence?: Evidence,
): Effect.Effect<void, never, Interface | EventBus.Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.injectRejectReasonToWorkerContext(reason, evidence)
  })

export const getNextTurnSystemContext: Effect.Effect<NextTurnSystemContext, never, Interface> =
  Effect.gen(function* () {
    const svc = yield* Service
    return yield* svc.getNextTurnSystemContext
  })

export const layerForTest: Layer.Layer<Interface, never, EventBus.Interface> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [EventBus.node] })