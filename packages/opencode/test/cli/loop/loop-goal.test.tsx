import { it, expect } from "bun:test"
import { Effect } from "effect"
import { GoalStore } from "@opencode-ai/core/session/loop-control/goal-store"
import { loopCommand } from "@/cli/cmd/run/loop/loop-cmd"

it("/loop goal --set X 写 GoalStore", () =>
  Effect.gen(function* () {
    const out = yield* loopCommand('goal --set "fix the build"')
    expect(out).toContain("fix the build")
    const goal = yield* GoalStore.get
    expect(goal).toBe("fix the build")
  }).pipe(
    Effect.provide(GoalStore.layerForTest),
    Effect.runPromise,
  ),
)

it("/loop goal <text> sets GoalStore without --set", () =>
  Effect.gen(function* () {
    const out = yield* loopCommand("goal ship a mature loop")
    expect(out).toContain("ship a mature loop")
    const goal = yield* GoalStore.get
    expect(goal).toBe("ship a mature loop")
  }).pipe(
    Effect.provide(GoalStore.layerForTest),
    Effect.runPromise,
  ),
)

it("/loop goal 显示当前 goal", () =>
  Effect.gen(function* () {
    yield* GoalStore.set("audit auth")
    const out = yield* loopCommand("goal")
    expect(out).toContain("audit auth")
  }).pipe(
    Effect.provide(GoalStore.layerForTest),
    Effect.runPromise,
  ),
)
