export * as RepairToolCall from "./repair-tool-call"

import { LLMEvent, type ToolCall } from "@opencode-ai/llm"

const INVALID = "invalid"

/** Official leftover `experimental_repairToolCall`: lowercase if advertised, else `invalid`. */
export function repair(event: ToolCall, advertised: ReadonlySet<string>, hidden: ReadonlySet<string>): ToolCall {
  if (event.providerExecuted) return event
  if (advertised.has(event.name)) return event
  const lower = event.name.toLowerCase()
  if (lower !== event.name && advertised.has(lower)) {
    return LLMEvent.toolCall({ ...event, name: lower })
  }
  if (hidden.has(INVALID) || advertised.has(INVALID)) {
    return LLMEvent.toolCall({
      ...event,
      name: INVALID,
      input: { tool: event.name, error: `Unknown tool: ${event.name}` },
    })
  }
  return event
}
