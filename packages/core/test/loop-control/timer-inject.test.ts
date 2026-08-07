import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { EventBus } from "../../src/session/loop-control/event-bus"
import { VerifierBiDirectional } from "../../src/session/runner/verifier-bi-directional"

test("timer reminder drains into next-turn system context separately from verifier", async () => {
  await Effect.gen(function* () {
    const bus = yield* EventBus.Service
    const vbd = yield* VerifierBiDirectional.Service
    yield* vbd.injectTimerReminder("Stop reminder: test").pipe(Effect.provideService(EventBus.Service, bus))
    yield* vbd
      .injectRejectReasonToWorkerContext("need more tests", [])
      .pipe(Effect.provideService(EventBus.Service, bus))
    const next = yield* vbd.getNextTurnSystemContext
    expect(next.timer_reminder).toContain("Stop reminder")
    expect(next.verifier_reject_reason).toContain("need more tests")
    const empty = yield* vbd.getNextTurnSystemContext
    expect(empty.timer_reminder).toBe("")
    expect(empty.verifier_reject_reason).toBe("")
  }).pipe(
    Effect.provide(VerifierBiDirectional.layerForTest),
    Effect.provide(EventBus.layerForTest),
    Effect.runPromise,
  )
})
