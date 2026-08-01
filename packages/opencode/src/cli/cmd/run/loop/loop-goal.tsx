import { Effect } from "effect"
import { GoalStore } from "@opencode-ai/core/session/loop-control/goal-store"

const parseArgs = (raw: string): { action: "show" | "set"; goal?: string } => {
  const m = raw.trim().match(/^--set\s+"?([^"]+)"?$/)
  if (m) return { action: "set", goal: m[1] }
  return { action: "show" }
}

export const loopGoalCommand = (raw: string) =>
  Effect.gen(function* () {
    const args = parseArgs(raw)
    if (args.action === "set" && args.goal !== undefined) {
      yield* GoalStore.set(args.goal)
      return `goal: ${args.goal}`
    }
    const goal = yield* GoalStore.get
    return goal ? `goal: ${goal}` : "no goal set"
  })
