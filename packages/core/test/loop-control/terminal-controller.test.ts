import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { TerminalController } from "../../src/session/loop-control/terminal-controller"
import { testEffect } from "../lib/effect"

const it = testEffect(TerminalController.layerForTest)

describe("TerminalController", () => {
  it.effect("starts in the running state with no accepted reason", () =>
    Effect.gen(function* () {
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("running")
      expect(snap.reason).toBe(null)
    }),
  )

  it.effect("verifier approval transitions running to terminated", () =>
    Effect.gen(function* () {
      yield* TerminalController.request("verifier_approved")
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("terminated")
      expect(snap.reason).toBe("verifier_approved")
    }),
  )

  it.effect("shouldContinue is true while running and false after termination", () =>
    Effect.gen(function* () {
      expect(yield* TerminalController.shouldContinue).toBe(true)
      yield* TerminalController.request("verifier_approved")
      expect(yield* TerminalController.shouldContinue).toBe(false)
    }),
  )

  it.effect("user_abort overrides a prior verifier approval", () =>
    Effect.gen(function* () {
      yield* TerminalController.request("verifier_approved")
      yield* TerminalController.request("user_abort")
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("aborted")
      expect(snap.reason).toBe("user_abort")
    }),
  )

  it.effect("hard_timeout overrides a prior verifier approval", () =>
    Effect.gen(function* () {
      yield* TerminalController.request("verifier_approved")
      yield* TerminalController.request("hard_timeout")
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("timed_out")
      expect(snap.reason).toBe("hard_timeout")
    }),
  )

  it.effect("budget_exhausted overrides a prior verifier approval", () =>
    Effect.gen(function* () {
      yield* TerminalController.request("verifier_approved")
      yield* TerminalController.request("budget_exhausted")
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("budget_exhausted")
      expect(snap.reason).toBe("budget_exhausted")
    }),
  )

  it.effect("unrecoverable_failure overrides a prior verifier approval", () =>
    Effect.gen(function* () {
      yield* TerminalController.request("verifier_approved")
      yield* TerminalController.request("unrecoverable_failure")
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("failed")
      expect(snap.reason).toBe("unrecoverable_failure")
    }),
  )

  it.effect("duplicate request for the same reason is idempotent", () =>
    Effect.gen(function* () {
      yield* TerminalController.request("user_abort")
      yield* TerminalController.request("user_abort")
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("aborted")
      expect(snap.reason).toBe("user_abort")
    }),
  )

  it.effect("a higher-precedence hard reason overrides a lower hard reason", () =>
    Effect.gen(function* () {
      yield* TerminalController.request("budget_exhausted")
      yield* TerminalController.request("user_abort")
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("aborted")
      expect(snap.reason).toBe("user_abort")
    }),
  )

  it.effect("verifier approval cannot override a hard terminal reason", () =>
    Effect.gen(function* () {
      yield* TerminalController.request("user_abort")
      yield* TerminalController.request("verifier_approved")
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("aborted")
      expect(snap.reason).toBe("user_abort")
    }),
  )

  it.effect("a lower-precedence hard reason cannot override a higher one", () =>
    Effect.gen(function* () {
      yield* TerminalController.request("user_abort")
      yield* TerminalController.request("budget_exhausted")
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("aborted")
      expect(snap.reason).toBe("user_abort")
    }),
  )

  it.effect("reset returns the controller to the running state", () =>
    Effect.gen(function* () {
      yield* TerminalController.request("verifier_approved")
      yield* TerminalController.reset
      const snap = yield* TerminalController.snapshot
      expect(snap.state).toBe("running")
      expect(snap.reason).toBe(null)
    }),
  )

  it.effect("snapshot records the first accepted reason after an override chain", () =>
    Effect.gen(function* () {
      yield* TerminalController.request("verifier_approved")
      yield* TerminalController.request("hard_timeout")
      const snap = yield* TerminalController.snapshot
      // hard_timeout overrode the soft acceptance, so it is now the accepted reason
      expect(snap.reason).toBe("hard_timeout")
      expect(snap.state).toBe("timed_out")
    }),
  )
})
