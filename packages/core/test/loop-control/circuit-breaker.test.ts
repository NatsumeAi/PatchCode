import { describe, expect, test } from "bun:test"
import { Duration, Effect } from "effect"
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

  it.effect("recordSuccess resets failure count and closes an Open breaker", () =>
    Effect.gen(function* () {
      for (let i = 0; i < 5; i++) {
        yield* CircuitBreaker.recordFailure
      }
      expect(yield* CircuitBreaker.state).toBe("Open")
      yield* CircuitBreaker.recordSuccess
      // True half-open is entered via cooldown + allowRequest probe; success closes.
      expect(yield* CircuitBreaker.state).toBe("Closed")
    }),
  )

  it.effect("per-provider isolation: A open does not block B", () =>
    Effect.gen(function* () {
      const svc = yield* CircuitBreaker.Service
      for (let i = 0; i < 5; i++) yield* svc.recordFailureFor("provider-a")
      expect(yield* svc.stateFor("provider-a")).toBe("Open")
      expect(yield* svc.stateFor("provider-b")).toBe("Closed")
      expect(yield* svc.allowRequest("provider-b")).toBe(true)
      expect(yield* svc.allowRequest("provider-a")).toBe(false)
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

  test("cooldown moves Open to HalfOpen and allowRequest claims a single probe", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const breaker = yield* CircuitBreaker.make(2, { enabled: true, cooldownMs: 20, windowMs: 60_000 })
        yield* breaker.recordFailure
        yield* breaker.recordFailure
        expect(yield* breaker.state).toBe("Open")
        yield* Effect.sleep(Duration.millis(25))
        expect(yield* breaker.stateFor("default")).toBe("HalfOpen")
        expect(yield* breaker.allowRequest()).toBe(true)
        expect(yield* breaker.allowRequest()).toBe(false)
        yield* breaker.recordSuccess
        expect(yield* breaker.state).toBe("Closed")
      }),
    )
  })
})
