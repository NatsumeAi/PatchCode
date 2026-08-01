import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { EventBus } from "../../src/session/loop-control/event-bus"
import { TerminalController } from "../../src/session/loop-control/terminal-controller"
import { Verifier } from "../../src/session/runner/verifier"
import {
  VerifierBiDirectional as VBD,
} from "../../src/session/runner/verifier-bi-directional"
import { DoneDecisionLoop } from "../../src/session/runner/done-decision-loop"

const layer = Layer.provide(VBD.layerForTest, EventBus.layerForTest).pipe(
  Layer.merge(EventBus.layerForTest),
  Layer.merge(TerminalController.layerForTest),
)

describe("DoneDecisionLoop", () => {
  test("approved → broken=true", () =>
    Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysApprove("p", "g")
      const out = yield* DoneDecisionLoop.onWorkerClaimComplete(v, {
        worker_claim: "Done.",
        worker_diff_path: "/diff",
      })
      expect(out.broken).toBe(true)
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("rejected → broken=false + reason pushed to next worker context", () =>
    Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysReject("p", "g")
      const out = yield* DoneDecisionLoop.onWorkerClaimComplete(v, {
        worker_claim: "Done.",
        worker_diff_path: "/diff",
      })
      expect(out.broken).toBe(false)

      const ctx = yield* VBD.getNextTurnSystemContext
      expect(ctx.verifier_reject_reason).toContain("Specific issue X")
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("approved does NOT push any reason into the reject queue", () =>
    Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysApprove("p", "g")
      yield* DoneDecisionLoop.onWorkerClaimComplete(v, {
        worker_claim: "Done.",
        worker_diff_path: "/diff",
      })
      const ctx = yield* VBD.getNextTurnSystemContext
      expect(ctx.verifier_reject_reason).toBe("")
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("multiple rejects accumulate reasons in the queue", () =>
    Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysReject("p", "g")
      yield* DoneDecisionLoop.onWorkerClaimComplete(v, { worker_claim: "first", worker_diff_path: "d1" })
      yield* DoneDecisionLoop.onWorkerClaimComplete(v, { worker_claim: "second", worker_diff_path: "d2" })

      const ctx = yield* VBD.getNextTurnSystemContext
      expect(ctx.verifier_reject_reason.split("\n")).toHaveLength(2)
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("approved → EventBus receives no VerifierRejectInjected event", () =>
    Effect.gen(function* () {
      const received: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "VerifierRejectInjected") received.push(e.reason)
        }),
      )
      const v = yield* Verifier.makeAlwaysApprove("p", "g")
      yield* DoneDecisionLoop.onWorkerClaimComplete(v, { worker_claim: "Done.", worker_diff_path: "/d" })
      expect(received).toEqual([])
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("rejected → EventBus receives VerifierRejectInjected event with the reason", () =>
    Effect.gen(function* () {
      const received: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "VerifierRejectInjected") received.push(e.reason)
        }),
      )
      const v = yield* Verifier.makeAlwaysReject("p", "g")
      yield* DoneDecisionLoop.onWorkerClaimComplete(v, { worker_claim: "Done.", worker_diff_path: "/d" })
      expect(received).toEqual(["Specific issue X"])
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("approval requests terminal state verifier_approved", () =>
    Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysApprove("p", "g")
      const out = yield* DoneDecisionLoop.onWorkerClaimComplete(v, {
        worker_claim: "Done.",
        worker_diff_path: "/d",
      })
      expect(out.broken).toBe(true)

      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("terminated")
      expect(snap.reason).toBe("verifier_approved")
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("rejection leaves the loop continuable and does NOT touch the terminal state", () =>
    Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysReject("p", "g")
      const out = yield* DoneDecisionLoop.onWorkerClaimComplete(v, {
        worker_claim: "Done.",
        worker_diff_path: "/d",
      })
      expect(out.broken).toBe(false)

      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("running")
      expect(snap.reason).toBe(null)

      const ctx = yield* VBD.getNextTurnSystemContext
      expect(ctx.verifier_reject_reason).toContain("Specific issue X")
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("rejection-cap exhaustion requests unrecoverable_failure and re-throws", () =>
    Effect.gen(function* () {
      const received: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "VerifierRejectInjected") received.push(e.reason)
        }),
      )
      const v = yield* Verifier.makeAlwaysReject("p", "g")
      let failed = false
      yield* Effect.gen(function* () {
        for (let i = 0; i < 9; i++) {
          yield* DoneDecisionLoop.onWorkerClaimComplete(v, { worker_claim: "c", worker_diff_path: "d" })
        }
      }).pipe(
        Effect.catchIf(
          (e): e is Verifier.VerifierRejectedTooManyTimes => e instanceof Verifier.VerifierRejectedTooManyTimes,
          () =>
            Effect.sync(() => {
              failed = true
            }),
        ),
      )
      expect(failed).toBe(true)

      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("failed")
      expect(snap.reason).toBe("unrecoverable_failure")
      // The first 8 audit calls injected a reject reason; the 9th never ran.
      expect(received).toHaveLength(8)
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )
})
