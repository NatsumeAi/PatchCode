import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ContextEngine } from "../../src/session/runner/context-engine"
import { IterationBudget } from "../../src/session/loop-control/iteration-budget"
import { testEffect } from "../lib/effect"

const layer = Layer.provide(ContextEngine.layerForTest, IterationBudget.layerParentDefault).pipe(
  Layer.merge(IterationBudget.layerParentDefault),
)

const it = testEffect(layer)

describe("ContextEngine", () => {
  it.effect("shouldProactiveCompact returns true when budget used ≥ 50%", () =>
    Effect.gen(function* () {
      yield* IterationBudget.consume(45)
      const out = yield* ContextEngine.shouldProactiveCompact
      expect(out).toBe(true)
    }),
  )

  it.effect("shouldProactiveCompact returns false when budget used < 50%", () =>
    Effect.gen(function* () {
      yield* IterationBudget.consume(27)
      const out = yield* ContextEngine.shouldProactiveCompact
      expect(out).toBe(false)
    }),
  )

  it.effect("shouldProactiveCompact returns false on fresh budget (0 consumed)", () =>
    Effect.gen(function* () {
      const out = yield* ContextEngine.shouldProactiveCompact
      expect(out).toBe(false)
    }),
  )

  it.effect("compact transitions lastCompactStepsConsumed and clears trigger", () =>
    Effect.gen(function* () {
      yield* IterationBudget.consume(50)
      expect(yield* ContextEngine.shouldProactiveCompact).toBe(true)
      yield* ContextEngine.compact
      // After compact, lastCompactStepsConsumed is updated; further consume under 30 steps won't re-trigger
      yield* IterationBudget.consume(5)
      expect(yield* ContextEngine.shouldProactiveCompact).toBe(false)
    }),
  )
})
