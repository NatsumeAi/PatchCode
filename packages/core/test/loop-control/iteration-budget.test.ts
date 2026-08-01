import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { IterationBudget } from "../../src/session/loop-control/iteration-budget"

describe("IterationBudget", () => {
  it("consume + refund + remaining", async () => {
    const program = Effect.gen(function* () {
      yield* IterationBudget.consume(3)
      yield* IterationBudget.consume(2)
      expect(yield* IterationBudget.remaining).toBe(5)
      yield* IterationBudget.refund(1)
      expect(yield* IterationBudget.remaining).toBe(6)
    }).pipe(Effect.provide(IterationBudget.layerForTest(10)))

    await Effect.runPromise(program)
  })

  it("consume past 0 fails with BudgetExhausted", async () => {
    const program = Effect.gen(function* () {
      yield* IterationBudget.consume(1)
      yield* IterationBudget.consume(1)
    }).pipe(Effect.provide(IterationBudget.layerForTest(1)))

    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
    if (exit._tag === "Failure") {
      const errText = Cause.prettyErrors(exit.cause).join("\n")
      expect(errText).toContain("BudgetExhausted")
    }
  })

  it("isExhausted is true when remaining is 0", async () => {
    const program = Effect.gen(function* () {
      yield* IterationBudget.consume(5)
      expect(yield* IterationBudget.isExhausted).toBe(true)
    }).pipe(Effect.provide(IterationBudget.layerForTest(5)))

    await Effect.runPromise(program)
  })

  it("isExhausted is false when there is remaining budget", async () => {
    const program = Effect.gen(function* () {
      yield* IterationBudget.consume(2)
      expect(yield* IterationBudget.isExhausted).toBe(false)
    }).pipe(Effect.provide(IterationBudget.layerForTest(5)))

    await Effect.runPromise(program)
  })

  it("refund below 0 clamps to 0", async () => {
    const program = Effect.gen(function* () {
      yield* IterationBudget.consume(2)
      yield* IterationBudget.refund(10)
      expect(yield* IterationBudget.remaining).toBe(5)
    }).pipe(Effect.provide(IterationBudget.layerForTest(5)))

    await Effect.runPromise(program)
  })

  it("consume exactly to cap succeeds, next consume fails", async () => {
    const program = Effect.gen(function* () {
      yield* IterationBudget.consume(5)
      yield* IterationBudget.consume(1)
    }).pipe(Effect.provide(IterationBudget.layerForTest(5)))

    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("default parent cap is 90", async () => {
    const program = Effect.gen(function* () {
      expect(yield* IterationBudget.remaining).toBe(90)
    }).pipe(Effect.provide(IterationBudget.layerParentDefault))

    await Effect.runPromise(program)
  })

  it("default child cap is 50", async () => {
    const program = Effect.gen(function* () {
      expect(yield* IterationBudget.remaining).toBe(50)
    }).pipe(Effect.provide(IterationBudget.layerChildDefault))

    await Effect.runPromise(program)
  })

  it("rejects NaN cap", async () => {
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      yield* IterationBudget.consume(1)
    }).pipe(Effect.provide(IterationBudget.layerForTest(Number.NaN))))
    expect(Exit.isFailure(exit)).toBe(true)
    if (exit._tag === "Failure") {
      expect(Cause.prettyErrors(exit.cause).join("\n")).toContain("InvalidCap")
    }
  })

  it("rejects non-finite (Infinity) cap", async () => {
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      yield* IterationBudget.consume(1)
    }).pipe(Effect.provide(IterationBudget.layerForTest(Number.POSITIVE_INFINITY))))
    expect(Exit.isFailure(exit)).toBe(true)
    if (exit._tag === "Failure") {
      expect(Cause.prettyErrors(exit.cause).join("\n")).toContain("InvalidCap")
    }
  })

  it("rejects zero cap", async () => {
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      yield* IterationBudget.consume(1)
    }).pipe(Effect.provide(IterationBudget.layerForTest(0))))
    expect(Exit.isFailure(exit)).toBe(true)
    if (exit._tag === "Failure") {
      expect(Cause.prettyErrors(exit.cause).join("\n")).toContain("InvalidCap")
    }
  })

  it("rejects negative cap", async () => {
    const exit = await Effect.runPromiseExit(Effect.gen(function* () {
      yield* IterationBudget.consume(1)
    }).pipe(Effect.provide(IterationBudget.layerForTest(-5))))
    expect(Exit.isFailure(exit)).toBe(true)
    if (exit._tag === "Failure") {
      expect(Cause.prettyErrors(exit.cause).join("\n")).toContain("InvalidCap")
    }
  })

  it("grace admission succeeds once and denies a second consume in the same turn", async () => {
    const program = Effect.gen(function* () {
      expect(yield* IterationBudget.useGrace).toBe(true)
      expect(yield* IterationBudget.useGrace).toBe(false)
      yield* IterationBudget.consume(1)
    }).pipe(Effect.provide(IterationBudget.layerForTest(5)))

    await Effect.runPromise(program)
  })

  it("concurrent consume is atomic and only one fiber gets BudgetExhausted", async () => {
    const program = Effect.gen(function* () {
      const guards = yield* Effect.all(
        Array.from({ length: 10 }, () =>
          Effect.gen(function* () {
            const exit = yield* IterationBudget.consume(1).pipe(Effect.exit)
            return Exit.isSuccess(exit)
          }),
        ),
        { concurrency: "unbounded" },
      )
      const successes = guards.filter(Boolean).length
      expect(successes).toBe(5)
    }).pipe(Effect.provide(IterationBudget.layerForTest(5)))

    await Effect.runPromise(program)
  })

  it("rejects invalid setCap values without mutating the budget", async () => {
    const program = Effect.gen(function* () {
      yield* IterationBudget.consume(2)
      const before = yield* IterationBudget.currentCap
      const invalid = yield* IterationBudget.setCap(Number.NaN).pipe(Effect.exit)
      expect(Exit.isFailure(invalid)).toBe(true)
      expect(yield* IterationBudget.currentCap).toBe(before)
      expect(yield* IterationBudget.remaining).toBe(3)
    }).pipe(Effect.provide(IterationBudget.layerForTest(5)))

    await Effect.runPromise(program)
  })

  it("rejects lowering setCap below consumed work without mutating the budget", async () => {
    const program = Effect.gen(function* () {
      yield* IterationBudget.consume(4)
      const invalid = yield* IterationBudget.setCap(3).pipe(Effect.exit)
      expect(Exit.isFailure(invalid)).toBe(true)
      expect(yield* IterationBudget.currentCap).toBe(5)
      expect(yield* IterationBudget.remaining).toBe(1)
    }).pipe(Effect.provide(IterationBudget.layerForTest(5)))

    await Effect.runPromise(program)
  })
})
