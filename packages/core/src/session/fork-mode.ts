import { Schema } from "effect"
import { SessionMessage } from "./message"

/**
 * How much of the parent session trace a subagent receives. Migrated from the
 * legacy loop-control fork-mode (dead path) and upgraded from plain text echo
 * to structured projection (tool names + result summaries survive).
 */
export const ForkMode = Schema.Literals(["FullHistory", "LastNTurns", "PromptOnly"])
export type ForkMode = typeof ForkMode.Type

const LAST_N_TURNS = 50
const TOOL_RESULT_CAP = 500

/**
 * Project parent session messages into a subagent prompt. Structured
 * inheritance: user text survives verbatim, assistant final text survives,
 * tool calls survive as "name: result-summary" lines (capped). Reasoning and
 * intermediate tool products are dropped.
 */
export function projectParentTrace(messages: readonly SessionMessage.Message[], mode: ForkMode): string {
  if (mode === "PromptOnly") return ""
  const selected = mode === "LastNTurns" ? messages.slice(-LAST_N_TURNS) : messages
  const lines: string[] = []
  for (const message of selected) {
    if (message.type === "user") {
      if (message.text) lines.push(`user: ${message.text}`)
    } else if (message.type === "assistant") {
      const text = message.content
        .filter((part): part is SessionMessage.AssistantText => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      if (text) lines.push(`assistant: ${text}`)
      for (const part of message.content) {
        if (part.type !== "tool") continue
        const state = part.state
        const result =
          state.status === "completed"
            ? String(
                state.content
                  .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
                  .map((c) => c.text)
                  .join("\n"),
              ).slice(0, TOOL_RESULT_CAP)
            : ""
        lines.push(`tool: ${part.name}${result ? ` -> ${result}` : ""}`)
      }
    }
  }
  return lines.join("\n")
}

/**
 * Seq-safe structured inheritance: single synthetic text block carrying the
 * projected parent trace. Prefer this over multi-row insert to avoid uniqueIndex risk.
 * Returns empty string for PromptOnly (caller should skip admit).
 */
export function projectParentMessagesForInsert(
  messages: readonly SessionMessage.Message[],
  mode: ForkMode,
): string {
  const trace = projectParentTrace(messages, mode)
  if (!trace) return ""
  return `Parent trace (structured)\n---\n${trace}`
}
