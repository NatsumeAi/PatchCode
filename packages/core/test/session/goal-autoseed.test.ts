import { expect, test } from "bun:test"
import { Effect } from "effect"
import { GoalStore } from "../../src/session/loop-control/goal-store"

test("setIfEmpty seeds empty goal and returns true", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* GoalStore.make
      const set = yield* store.setIfEmpty("Fix parser bug in src/a.ts")
      expect(set).toBe(true)
      expect(yield* store.get).toBe("Fix parser bug in src/a.ts")
      // second setIfEmpty does not override
      const again = yield* store.setIfEmpty("other")
      expect(again).toBe(false)
      expect(yield* store.get).toBe("Fix parser bug in src/a.ts")
    }),
  )
})

test("explicit set overrides and setIfEmpty no longer writes", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* GoalStore.make
      yield* store.set("explicit goal")
      expect(yield* store.setIfEmpty("auto")).toBe(false)
      expect(yield* store.get).toBe("explicit goal")
    }),
  )
})
