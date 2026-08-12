/**
 * Untrusted tool-result framing (W4 / hermes-style).
 * Wraps external tool output so the model treats it as data, not instructions,
 * and neutralizes delimiter tokens that could break the message frame.
 */

/** Tools whose outputs stay in-workspace and are not wrapped. */
const TRUSTED_TOOL_NAMES = new Set([
  "read",
  "edit",
  "write",
  "apply_patch",
  "glob",
  "grep",
  "todowrite",
  "todo",
  "plan_enter",
  "plan_exit",
  "question",
  "skill",
  "task",
  "peer_message",
  "lsp",
  "memory_list",
  "memory_read",
  "memory_search",
  "memory_add_note",
])

/** Delimiter / role-injection tokens neutralized inside untrusted payloads. */
const DELIMITER_RE =
  /<\/?(?:system|tool_result|untrusted_tool_result|assistant|user|tool_call|tool_response)\b[^>]*>/gi

export function isTrustedToolOutput(toolName: string): boolean {
  return TRUSTED_TOOL_NAMES.has(toolName)
}

/** Strip or mangle delimiter-like tokens so they cannot close outer frames. */
export function neutralizeDelimiters(text: string): string {
  return text.replace(DELIMITER_RE, (match) => match.replace(/[<>]/g, (ch) => (ch === "<" ? "‹" : "›")))
}

/**
 * Frame a tool result for the model. Trusted tools return the value unchanged.
 * Untrusted tools wrap string (or JSON) payloads in <untrusted_tool_result>.
 */
export function frameToolResult(toolName: string, result: unknown): unknown {
  if (isTrustedToolOutput(toolName)) return result
  if (typeof result === "string") {
    return `<untrusted_tool_result>\n${neutralizeDelimiters(result)}\n</untrusted_tool_result>`
  }
  // Structured results: wrap a JSON snapshot so nested text is still neutralized.
  try {
    const json = neutralizeDelimiters(JSON.stringify(result))
    return {
      untrusted: true,
      framed: `<untrusted_tool_result>\n${json}\n</untrusted_tool_result>`,
      result,
    }
  } catch {
    return result
  }
}
