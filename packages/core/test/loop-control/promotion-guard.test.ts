import { describe, expect } from "bun:test"
import { Duration, Effect, Fiber, Exit } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { PromotionGuard } from "../../src/session/loop-control/promotion-guard"
import { testEffect } from "../lib/effect"

const it = testEffect(PromotionGuard.layerForTest)

describe("PromotionGuard — §8e-2/3 timeout + atomic guard", () => {
  it.effect("waitForPromotion times out after timeoutMs → returns Timeout", () =>
    Effect.gen(function* () {
      const f = yield* PromotionGuard.waitForPromotion({ jobID: "j-1", timeoutMs: 60_000 }).pipe(
        Effect.forkScoped,
      )
      yield* TestClock.adjust(Duration.seconds(65))
      const out = yield* Fiber.join(f)
      expect(out).toEqual({ _tag: "Timeout" })
    }),
  )

  it.effect("promote twice on same jobID → second fails with DoublePromotion", () =>
    Effect.gen(function* () {
      yield* PromotionGuard.promote({ jobID: "j-1", payload: { i: 1 } })
      const exit = yield* PromotionGuard.promote({ jobID: "j-1", payload: { i: 2 } }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("concurrent promote race → exactly one success, one DoublePromotion", () =>
    Effect.gen(function* () {
      const a = yield* PromotionGuard.promote({ jobID: "x", payload: { i: 1 } }).pipe(Effect.forkScoped)
      const b = yield* PromotionGuard.promote({ jobID: "x", payload: { i: 2 } }).pipe(Effect.forkScoped)
      const ea = yield* Fiber.await(a)
      const eb = yield* Fiber.await(b)
      const exits = [ea, eb]
      const successes = exits.filter((x) => Exit.isSuccess(x))
      const failures = exits.filter((x) => Exit.isFailure(x))
      expect(successes).toHaveLength(1)
      expect(failures).toHaveLength(1)
    }),
  )

  it.effect("promote then waitForPromotion → returns Success with payload (already-promoted fast path)", () =>
    Effect.gen(function* () {
      yield* PromotionGuard.promote({ jobID: "p", payload: { v: 42 } })
      const out = yield* PromotionGuard.waitForPromotion({ jobID: "p", timeoutMs: 5_000 })
      expect(out).toEqual({ _tag: "Success", value: { v: 42 } })
    }),
  )

  it.effect("waitForPromotion resolves when promote fires while waiting → Success", () =>
    Effect.gen(function* () {
      const f = yield* PromotionGuard.waitForPromotion({ jobID: "w", timeoutMs: 30_000 }).pipe(
        Effect.forkScoped,
      )
      yield* PromotionGuard.promote({ jobID: "w", payload: "done" })
      const out = yield* Fiber.join(f)
      expect(out).toEqual({ _tag: "Success", value: "done" })
    }),
  )

  it.effect("different jobIDs do NOT collide — promote j-a then j-b both succeed", () =>
    Effect.gen(function* () {
      yield* PromotionGuard.promote({ jobID: "j-a", payload: 1 })
      yield* PromotionGuard.promote({ jobID: "j-b", payload: 2 })
      const a = yield* PromotionGuard.waitForPromotion({ jobID: "j-a", timeoutMs: 1_000 })
      const b = yield* PromotionGuard.waitForPromotion({ jobID: "j-b", timeoutMs: 1_000 })
      expect(a).toEqual({ _tag: "Success", value: 1 })
      expect(b).toEqual({ _tag: "Success", value: 2 })
    }),
  )
})
