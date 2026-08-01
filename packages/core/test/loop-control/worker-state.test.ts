import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { InvalidTransition, WorkerState } from "../../src/session/loop-control/worker-state"

describe("WorkerState", () => {
  it("active → waiting_on_child → active", async () => {
    const program = Effect.gen(function* () {
      expect((yield* WorkerState.current)._tag).toBe("Active")
      yield* WorkerState.transition({ _tag: "Waiting", reason: "OnChild" })
      expect((yield* WorkerState.current)._tag).toBe("Waiting")
      expect(yield* WorkerState.currentHarness).toBe("Idle")
      yield* WorkerState.transition({ _tag: "Active" })
      expect((yield* WorkerState.current)._tag).toBe("Active")
      expect(yield* WorkerState.currentHarness).toBe("Busy")
    }).pipe(Effect.provide(WorkerState.layerForTest))

    await Effect.runPromise(program)
  })

  it("active → active is idempotent (no-op)", async () => {
    const program = Effect.gen(function* () {
      yield* WorkerState.transition({ _tag: "Active" })
      yield* WorkerState.transition({ _tag: "Active" })
      expect((yield* WorkerState.current)._tag).toBe("Active")
    }).pipe(Effect.provide(WorkerState.layerForTest))

    await Effect.runPromise(program)
  })

  it("waiting_on_background → waiting_on_child is allowed (waiting-internal transitions)", async () => {
    const program = Effect.gen(function* () {
      yield* WorkerState.transition({ _tag: "Waiting", reason: "OnBackgroundExec" })
      yield* WorkerState.transition({ _tag: "Waiting", reason: "OnChild" })
      const c = yield* WorkerState.current
      expect(c._tag).toBe("Waiting")
      if (c._tag === "Waiting") expect(c.reason).toBe("OnChild")
    }).pipe(Effect.provide(WorkerState.layerForTest))

    await Effect.runPromise(program)
  })

  it("active → dead (NoHeartbeatN) is allowed", async () => {
    const program = Effect.gen(function* () {
      yield* WorkerState.transition({ _tag: "Dead", reason: "NoHeartbeatN" })
      expect((yield* WorkerState.current)._tag).toBe("Dead")
      expect(yield* WorkerState.currentHarness).toBe("Stuck")
    }).pipe(Effect.provide(WorkerState.layerForTest))

    await Effect.runPromise(program)
  })

  it("dead → active is rejected with InvalidTransition", async () => {
    const program = Effect.gen(function* () {
      yield* WorkerState.transition({ _tag: "Dead", reason: "NoHeartbeatN" })
      yield* WorkerState.transition({ _tag: "Active" })
    }).pipe(Effect.provide(WorkerState.layerForTest))

    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
    if (exit._tag === "Failure") {
      const errText = Cause.prettyErrors(exit.cause).join("\n")
      expect(errText).toContain("LoopControl.WorkerState.InvalidTransition")
    }
  })

  it("dead → waiting is also rejected (once dead, no exit)", async () => {
    const program = Effect.gen(function* () {
      yield* WorkerState.transition({ _tag: "Dead", reason: "ParentAbort" })
      yield* WorkerState.transition({ _tag: "Waiting", reason: "OnChild" })
    }).pipe(Effect.provide(WorkerState.layerForTest))

    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("isBusy mapping — Active = true, Waiting = false, Dead = false", async () => {
    const program = Effect.gen(function* () {
      expect(yield* WorkerState.isBusy).toBe(true)
      yield* WorkerState.transition({ _tag: "Waiting", reason: "OnForegroundExec" })
      expect(yield* WorkerState.isBusy).toBe(false)
      yield* WorkerState.transition({ _tag: "Dead", reason: "GraceCalledThenExhausted" })
      expect(yield* WorkerState.isBusy).toBe(false)
    }).pipe(Effect.provide(WorkerState.layerForTest))

    await Effect.runPromise(program)
  })

  it("InvalidTransition is a typed error carrying from + to", () => {
    const from = { _tag: "Dead", reason: "NoHeartbeatN" } as const
    const to = { _tag: "Active" } as const
    const err = new InvalidTransition({ from, to })
    expect(err._tag).toBe("LoopControl.WorkerState.InvalidTransition")
    expect(err.from._tag).toBe("Dead")
    expect(err.to._tag).toBe("Active")
  })

  it("reset force-sets Active from Dead for an intentional new drain", async () => {
    const program = Effect.gen(function* () {
      yield* WorkerState.transition({ _tag: "Dead", reason: "ParentAbort" })
      expect((yield* WorkerState.current)._tag).toBe("Dead")
      yield* WorkerState.reset
      expect((yield* WorkerState.current)._tag).toBe("Active")
      expect(yield* WorkerState.currentHarness).toBe("Busy")
    }).pipe(Effect.provide(WorkerState.layerForTest))

    await Effect.runPromise(program)
  })
})
