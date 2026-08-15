import { it, expect } from "bun:test"
import { Effect } from "effect"
import { IterationBudget } from "@opencode-ai/core/session/loop-control/iteration-budget"
import { loopCommand } from "@/cli/cmd/run/loop/loop-cmd"

it("/loop budget 显示当前剩余", () =>
  Effect.gen(function* () {
    yield* IterationBudget.consume(3)
    const out = yield* loopCommand("budget")
    expect(out).toContain("remaining 87")
    expect(out).toContain("cap 90")
  }).pipe(
    Effect.provide(IterationBudget.layerForTest(90)),
    Effect.runPromise,
  ),
)

it("/loop budget set --cap 120 改 cap", () =>
  Effect.gen(function* () {
    const out = yield* loopCommand("budget set --cap 120")
    expect(out).toContain("cap 120")
  }).pipe(
    Effect.provide(IterationBudget.layerForTest(90)),
    Effect.runPromise,
  ),
)

it("/loop budget refund --turns 5 退回 5 turn", () =>
  Effect.gen(function* () {
    yield* IterationBudget.consume(10)
    const out = yield* loopCommand("budget refund --turns 5")
    expect(out).toContain("remaining 85")
  }).pipe(
    Effect.provide(IterationBudget.layerForTest(90)),
    Effect.runPromise,
  ),
)

it("/loop budget reset 重置 consumed", () =>
  Effect.gen(function* () {
    yield* IterationBudget.consume(50)
    const out = yield* loopCommand("budget reset")
    expect(out).toContain("reset")
    const remaining = yield* IterationBudget.remaining
    expect(remaining).toBe(90)
  }).pipe(
    Effect.provide(IterationBudget.layerForTest(90)),
    Effect.runPromise,
  ),
)
