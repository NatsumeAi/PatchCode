/**
 * Legacy adapter over session/fork-mode (single authority for projection).
 * The session host uses projectParentTrace / projectParentMessagesForInsert directly.
 */
import { Effect } from "effect"
import { projectParentTrace, ForkMode as SessionForkMode } from "../fork-mode"

export const ForkMode = SessionForkMode
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

/** Legacy adapter: role/content pairs → text projection. */
export const buildForkPrompt = (input: BuildForkInput) =>
  Effect.gen(function* () {
    if (input.mode === "PromptOnly") {
      return input.promptOverride ?? ""
    }
    const asMessages = input.parentTrace.map((m) =>
      m.role === "assistant"
        ? ({ type: "assistant" as const, content: [{ type: "text" as const, text: m.content }] })
        : ({ type: "user" as const, text: m.content }),
    )
    const trace = projectParentTrace(asMessages as never, input.mode)
    if (!trace) return input.promptOverride ?? ""
    const prefix = input.promptOverride ? `${input.promptOverride}\n\nParent trace:\n---\n` : "Parent trace:\n---\n"
    return prefix + trace
  })
