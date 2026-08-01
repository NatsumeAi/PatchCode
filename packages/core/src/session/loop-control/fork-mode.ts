import { Effect, Schema } from "effect"

export const ForkMode = Schema.Literals(["FullHistory", "LastNTurns", "PromptOnly"])
export type ForkMode = typeof ForkMode.Type

interface ParentMessage {
  role: string
  content: string
}

interface BuildForkInput {
  mode: ForkMode
  parentTrace: ParentMessage[]
  promptOverride?: string
}

export const buildForkPrompt = (input: BuildForkInput) =>
  Effect.gen(function* () {
    if (input.mode === "PromptOnly") {
      return input.promptOverride ?? ""
    }
    const trace = input.mode === "LastNTurns" ? input.parentTrace.slice(-50) : input.parentTrace
    const formatted = trace.map((m) => `${m.role}: ${m.content}`).join("\n---\n")
    const prefix = input.promptOverride ? `${input.promptOverride}\n\nParent trace:\n---\n` : "Parent trace:\n---\n"
    return prefix + formatted
  })
