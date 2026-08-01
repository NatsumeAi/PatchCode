import { Effect } from "effect"
import { IterationBudget } from "@opencode-ai/core/session/loop-control/iteration-budget"

type Action = "show" | "set" | "refund" | "reset"

const parseArgs = (raw: string): { action: Action; cap?: number; turns?: number } => {
  const tok = raw.split(/\s+/)
  if (tok[0] === "set" && tok[1] === "--cap") return { action: "set", cap: Number(tok[2]) }
  if (tok[0] === "refund" && tok[1] === "--turns") return { action: "refund", turns: Number(tok[2]) }
  if (tok[0] === "reset") return { action: "reset" }
  return { action: "show" }
}

export const loopBudgetCommand = (raw: string) =>
  Effect.gen(function* () {
    const args = parseArgs(raw)
    if (args.action === "show") {
      const remaining = yield* IterationBudget.remaining
      const cap = yield* IterationBudget.currentCap
      return `remaining ${remaining}\ncap ${cap}`
    }
    if (args.action === "set" && args.cap !== undefined) {
      yield* IterationBudget.setCap(args.cap)
      return `cap ${args.cap}`
    }
    if (args.action === "refund" && args.turns !== undefined) {
      yield* IterationBudget.refund(args.turns)
      const remaining = yield* IterationBudget.remaining
      return `refunded ${args.turns}, remaining ${remaining}`
    }
    if (args.action === "reset") {
      yield* IterationBudget.reset()
      return "reset"
    }
    return "unknown command"
  })
