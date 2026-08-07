export * as VerifierBiDirectional from "./verifier-bi-directional"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { EventBus } from "../loop-control/event-bus"
import { makeGlobalNode } from "../../effect/app-node"
import type { VerifierResponse } from "./verifier"

/**
 * L3 Verifier ↔ worker bi-directional channel + harness timer feedback.
 *
 * `injectRejectReasonToWorkerContext` — verifier reject reasons.
 * `injectTimerReminder` — StopReminder / wait-idle harness messages (separate
 * channel so product inject works without conflating with verifier verdicts).
 *
 * `getNextTurnSystemContext` drains BOTH queues atomically.
 */
export interface NextTurnSystemContext {
  readonly verifier_reject_reason: string
  readonly verifier_reject_evidence: ReadonlyArray<{ file: string; line?: number; issue: string }>
  readonly timer_reminder: string
}

type Evidence = NonNullable<VerifierResponse["evidence"]>

export interface Interface {
  readonly injectRejectReasonToWorkerContext: (
    reason: string,
    evidence?: Evidence,
  ) => Effect.Effect<void, never, EventBus.Interface>
  readonly injectTimerReminder: (reason: string) => Effect.Effect<void, never, EventBus.Interface>
  readonly getNextTurnSystemContext: Effect.Effect<NextTurnSystemContext>
}

export const Service = Context.Service<Interface>("@opencode/Runner/VerifierBiDirectional")

type Feedback = {
  readonly reasons: ReadonlyArray<string>
  readonly evidence: Evidence
  readonly timers: ReadonlyArray<string>
}

const emptyFeedback: Feedback = { reasons: [], evidence: [], timers: [] }

export const make: Effect.Effect<Interface, never, EventBus.Interface> = Effect.gen(function* () {
  const feedback = yield* SynchronizedRef.make<Feedback>(emptyFeedback)

  const injectRejectReasonToWorkerContext: Interface["injectRejectReasonToWorkerContext"] = (
    reason,
    evidence,
  ) =>
    Effect.gen(function* () {
      yield* SynchronizedRef.update(feedback, (f) => ({
        reasons: [...f.reasons, reason],
        evidence:
          evidence && evidence.length > 0 ? [...f.evidence, ...evidence] : f.evidence,
        timers: f.timers,
      }))
      yield* EventBus.publish({ _tag: "VerifierRejectInjected", reason })
    })

  const injectTimerReminder: Interface["injectTimerReminder"] = (reason) =>
    Effect.gen(function* () {
      yield* SynchronizedRef.update(feedback, (f) => ({
        ...f,
        timers: [...f.timers, reason],
      }))
    })

  const getNextTurnSystemContext: Interface["getNextTurnSystemContext"] = Effect.gen(function* () {
    const { reasons, evidence, timers } = yield* SynchronizedRef.modify(
      feedback,
      (f): readonly [Feedback, Feedback] => [f, emptyFeedback],
    )
    return {
      verifier_reject_reason: reasons.length > 0 ? reasons.join("\n") : "",
      verifier_reject_evidence: evidence,
      timer_reminder: timers.length > 0 ? timers.join("\n") : "",
    }
  })

  return { injectRejectReasonToWorkerContext, injectTimerReminder, getNextTurnSystemContext }
})

export const injectRejectReasonToWorkerContext = (
  reason: string,
  evidence?: Evidence,
): Effect.Effect<void, never, Interface | EventBus.Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.injectRejectReasonToWorkerContext(reason, evidence)
  })

export const injectTimerReminder = (
  reason: string,
): Effect.Effect<void, never, Interface | EventBus.Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.injectTimerReminder(reason)
  })

export const getNextTurnSystemContext: Effect.Effect<NextTurnSystemContext, never, Interface> =
  Effect.gen(function* () {
    const svc = yield* Service
    return yield* svc.getNextTurnSystemContext
  })

export const layerForTest: Layer.Layer<Interface, never, EventBus.Interface> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [EventBus.node] })
