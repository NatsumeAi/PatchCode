import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { GoalStore } from "../../src/session/loop-control/goal-store"
import { testEffect } from "../lib/effect"

const it = testEffect(GoalStore.layerForTest)

describe("GoalStore", () => {
  it.effect("starts empty", () =>
    Effect.gen(function* () {
      expect(yield* GoalStore.get).toBe("")
    }),
  )

  it.effect("set then get returns the goal", () =>
    Effect.gen(function* () {
      yield* GoalStore.set("Ship the verifier wiring")
      expect(yield* GoalStore.get).toBe("Ship the verifier wiring")
    }),
  )

  it.effect("set overwrites the previous goal", () =>
    Effect.gen(function* () {
      yield* GoalStore.set("first goal")
      yield* GoalStore.set("second goal")
      expect(yield* GoalStore.get).toBe("second goal")
    }),
  )

  it.effect("setIfEmpty only writes when empty", () =>
    Effect.gen(function* () {
      expect(yield* GoalStore.setIfEmpty("seeded from user")).toBe(true)
      expect(yield* GoalStore.get).toBe("seeded from user")
      expect(yield* GoalStore.setIfEmpty("should not replace")).toBe(false)
      expect(yield* GoalStore.get).toBe("seeded from user")
    }),
  )
})
