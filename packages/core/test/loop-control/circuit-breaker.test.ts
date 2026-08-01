import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CircuitBreaker } from "../../src/session/loop-control/circuit-breaker"
import { testEffect } from "../lib/effect"

const it = testEffect(CircuitBreaker.layerForTest)

describe("CircuitBreaker", () => {
  it.effect("starts Closed", () =>
    Effect.gen(function* () {
      expect(yield* CircuitBreaker.state).toBe("Closed")
    }),
  )

  it.effect("opens after threshold consecutive failures", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 5; i++) {
        yield* CircuitBreaker.recordFailure
      }
      expect(yield* CircuitBreaker.state).toBe("Open")
    }),
  )

  it.effect("stays Closed below threshold", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 4; i++) {
        yield* CircuitBreaker.recordFailure
      }
      expect(yield* CircuitBreaker.state).toBe("Closed")
    }),
  )

  it.effect("recordFailure after Open is a no-op", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 5; i++) {
        yield* CircuitBreaker.recordFailure
      }
      yield* CircuitBreaker.recordFailure
      yield* CircuitBreaker.recordFailure
      expect(yield* CircuitBreaker.state).toBe("Open")
    }),
  )

  it.effect("recordSuccess resets failure count and half-opens an Open breaker", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 5; i++) {
        yield* CircuitBreaker.recordFailure
      }
      expect(yield* CircuitBreaker.state).toBe("Open")
      yield* CircuitBreaker.recordSuccess
      expect(yield* CircuitBreaker.state).toBe("HalfOpen")
    }),
  )

  it.effect("recordSuccess in Closed keeps Closed and clears failures", () =>
    Effect.gen(function* () {
      yield* CircuitBreaker.recordFailure
      yield* CircuitBreaker.recordFailure
      yield* CircuitBreaker.recordSuccess
      expect(yield* CircuitBreaker.state).toBe("Closed")
      for (let i = 0; i < 4; i++) {
        yield* CircuitBreaker.recordFailure
      }
      // failures were reset by the success, so 4 more failures do not open yet
      expect(yield* CircuitBreaker.state).toBe("Closed")
    }),
  )

  it.effect("reset returns to Closed and clears failures", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 5; i++) {
        yield* CircuitBreaker.recordFailure
      }
      expect(yield* CircuitBreaker.state).toBe("Open")
      yield* CircuitBreaker.reset
      expect(yield* CircuitBreaker.state).toBe("Closed")
      for (let i = 0; i < 4; i++) {
        yield* CircuitBreaker.recordFailure
      }
      expect(yield* CircuitBreaker.state).toBe("Closed")
    }),
  )
})
