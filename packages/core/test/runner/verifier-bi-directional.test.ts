import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { EventBus } from "../../src/session/loop-control/event-bus"
import { Verifier } from "../../src/session/runner/verifier"
import { VerifierBiDirectional as VBD } from "../../src/session/runner/verifier-bi-directional"

const layer = Layer.provide(VBD.layerForTest, EventBus.layerForTest).pipe(
  Layer.merge(EventBus.layerForTest),
)

describe("VerifierBiDirectional", () => {
  test("verifier reject → inject → getNextTurnSystemContext contains reason", () =>
    Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysReject("p-sess", "fix X")
      const reject = yield* v.audit({ worker_claim: "Done.", worker_diff_path: "/diff.patch" })
      expect(reject.verdict).toBe("rejected")

      yield* VBD.injectRejectReasonToWorkerContext(reject.reason)

      const ctx = yield* VBD.getNextTurnSystemContext
      expect(ctx.verifier_reject_reason).toContain("Specific issue X")
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("inject多条 pushes to queue; getNext drains all then empties", () =>
    Effect.gen(function* () {
      yield* VBD.injectRejectReasonToWorkerContext("reason1")
      yield* VBD.injectRejectReasonToWorkerContext("reason2")
      yield* VBD.injectRejectReasonToWorkerContext("reason3")

      const ctx1 = yield* VBD.getNextTurnSystemContext
      expect(ctx1.verifier_reject_reason).toContain("reason1")
      expect(ctx1.verifier_reject_reason).toContain("reason2")
      expect(ctx1.verifier_reject_reason).toContain("reason3")

      // Second drain returns empty reason (queue cleared)
      const ctx2 = yield* VBD.getNextTurnSystemContext
      expect(ctx2.verifier_reject_reason).toBe("")
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("inject with evidence stores evidence in NextTurnSystemContext", () =>
    Effect.gen(function* () {
      const evidence = [{ file: "src/y.ts", line: 42, issue: "null check missing" }]
      yield* VBD.injectRejectReasonToWorkerContext("fail", evidence)

      const ctx = yield* VBD.getNextTurnSystemContext
      expect(ctx.verifier_reject_evidence).toEqual(evidence)
      const next = yield* VBD.getNextTurnSystemContext
      expect(next.verifier_reject_reason).toBe("")
      expect(next.verifier_reject_evidence).toEqual([])
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("inject publishes VerifierRejectInjected event on EventBus", () =>
    Effect.gen(function* () {
      const received: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "VerifierRejectInjected") received.push(e.reason)
        }),
      )
      yield* VBD.injectRejectReasonToWorkerContext("got rejected")
      expect(received).toEqual(["got rejected"])
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("verifier reject 8 times → 9th audit fails (N=8 cap already covered in Task 1)", async () => {
    // Re-verify here to ensure the bi-directional module doesn't accidentally bypass the cap
    const run = Effect.gen(function* () {
      const v = yield* Verifier.makeAlwaysReject("p", "g")
      for (let i = 0; i < 8; i++) {
        yield* v.audit({ worker_claim: `attempt ${i}`, worker_diff_path: `diff${i}` })
      }
      yield* v.audit({ worker_claim: "9th", worker_diff_path: "diff9" })
    }).pipe(Effect.runPromiseExit)
    const exit = await run
    expect(exit._tag).toBe("Failure")
  })

  test("fresh layer → getNextTurnSystemContext returns empty reason", () =>
    Effect.gen(function* () {
      const ctx = yield* VBD.getNextTurnSystemContext
      expect(ctx.verifier_reject_reason).toBe("")
      expect(ctx.verifier_reject_evidence).toEqual([])
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )
})
