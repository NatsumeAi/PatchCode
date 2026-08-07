import { expect, test } from "bun:test"
import { Effect } from "effect"
import { TreeBudget } from "../../src/session/tree-budget"

test("unlimited when no limit set", async () => {
  await Effect.gen(function* () {
    const tb = yield* TreeBudget.make()
    expect(yield* tb.remaining).toBe(Number.POSITIVE_INFINITY)
    const r = yield* tb.debit(1_000_000)
    expect(r.exhausted).toBe(false)
  }).pipe(Effect.runPromise)
})

test("exhausts when debit exceeds limit", async () => {
  await Effect.gen(function* () {
    const tb = yield* TreeBudget.make(100)
    expect((yield* tb.debit(40)).exhausted).toBe(false)
    expect((yield* tb.debit(70)).exhausted).toBe(true)
    expect(yield* tb.remaining).toBe(0)
  }).pipe(Effect.runPromise)
})
