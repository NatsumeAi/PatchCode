import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ContextEngine } from "../../src/session/runner/context-engine"
import { testEffect } from "../lib/effect"

const it = testEffect(ContextEngine.layerForTest)

describe("ContextEngine", () => {
  it.effect("no usage yet is false", () =>
    Effect.gen(function* () {
      expect(yield* ContextEngine.shouldProactiveCompact).toBe(false)
    }),
  )

  it.effect("low-step high-token triggers", () =>
    Effect.gen(function* () {
      const engine = yield* ContextEngine.Service
      yield* engine.setUsage({ tokens: 95_000, window: 100_000 })
      expect(yield* engine.shouldProactiveCompact).toBe(true)
    }),
  )

  it.effect("high-step low-token does not trigger", () =>
    Effect.gen(function* () {
      const engine = yield* ContextEngine.Service
      yield* engine.setUsage({ tokens: 1_000, window: 100_000 })
      expect(yield* engine.shouldProactiveCompact).toBe(false)
    }),
  )

  it.effect("compact cooldown blocks a second fire in the same drain", () =>
    Effect.gen(function* () {
      const engine = yield* ContextEngine.Service
      yield* engine.setUsage({ tokens: 95_000, window: 100_000 })
      expect(yield* engine.shouldProactiveCompact).toBe(true)
      yield* engine.compact
      expect(yield* engine.shouldProactiveCompact).toBe(false)
    }),
  )
})
