import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { IterationBudget } from "../../src/session/loop-control/iteration-budget"
import { testEffect } from "../lib/effect"

const it = testEffect(IterationBudget.layerForTest(90, 4))

describe("IterationBudget active agent cap — §8e-5", () => {
  it.effect("active cap=4, 5th acquire fails with ActiveAgentExceeded", () =>
    Effect.gen(function* () {
      const guards = []
      for (let i = 0; i < 4; i++) {
        const g = yield* IterationBudget.acquireAgentGuard
        guards.push(g)
      }
      const exit = yield* IterationBudget.acquireAgentGuard.pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("guard release frees the slot; re-acquire succeeds", () =>
    Effect.gen(function* () {
      const g = yield* IterationBudget.acquireAgentGuard
      yield* g.release
      yield* IterationBudget.acquireAgentGuard
      yield* IterationBudget.acquireAgentGuard
      yield* IterationBudget.acquireAgentGuard
      yield* IterationBudget.acquireAgentGuard
    }),
  )

  it.effect("active cap is independent of iteration budget cap", () =>
    Effect.gen(function* () {
      yield* IterationBudget.consume(90) // exhaust iteration budget entirely
      const g = yield* IterationBudget.acquireAgentGuard // active cap still has room
      expect((yield* IterationBudget.remaining)).toBe(0)
      yield* g.release
    }),
  )

  it.effect("existing consume/refund behavior unchanged", () =>
    Effect.gen(function* () {
      yield* IterationBudget.consume(50)
      expect(yield* IterationBudget.remaining).toBe(40)
      yield* IterationBudget.refund(10)
      expect(yield* IterationBudget.remaining).toBe(50)
      expect(yield* IterationBudget.isExhausted).toBe(false)
    }),
  )
})

describe("IterationBudget layer with default active cap", () => {
  test("layerForTest(90) uses DEFAULT_ACTIVE_CAP=4", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 4; i++) {
        yield* IterationBudget.acquireAgentGuard
      }
      const exit = yield* IterationBudget.acquireAgentGuard.pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }).pipe(Effect.provide(IterationBudget.layerForTest(90)), Effect.runPromise),
  )
})
