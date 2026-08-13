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

function wrapUntrusted(text: string): string {
  return `<untrusted_tool_result>\n${neutralizeDelimiters(text)}\n</untrusted_tool_result>`
}

/**
 * Frame a tool result for the model. Trusted tools return the value unchanged.
 * Untrusted tools wrap the *visible* payload (string or ToolResultValue) so the
 * provider stringify path cannot leak raw injection text beside a framed copy.
 */
export function frameToolResult(toolName: string, result: unknown): unknown {
  if (isTrustedToolOutput(toolName)) return result
  if (typeof result === "string") return wrapUntrusted(result)
  if (result && typeof result === "object" && "type" in result) {
    const r = result as { type: string; value?: unknown }
    if (r.type === "text" && typeof r.value === "string") return { ...r, value: wrapUntrusted(r.value) }
    if (r.type === "json") {
      const raw = typeof r.value === "string" ? r.value : JSON.stringify(r.value)
      return { type: "text", value: wrapUntrusted(raw ?? "") }
    }
    if (r.type === "content" && Array.isArray(r.value)) {
      return {
        ...r,
        value: r.value.map((part) => {
          if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
            const text = (part as { text?: unknown }).text
            if (typeof text === "string") return { ...part, text: wrapUntrusted(text) }
          }
          return part
        }),
      }
    }
    if (r.type === "error") {
      const extra = r as { message?: unknown }
      const msg =
        typeof r.value === "string" ? r.value : typeof extra.message === "string" ? extra.message : JSON.stringify(r)
      return { ...r, value: wrapUntrusted(String(msg)) }
    }
  }
  try {
    return wrapUntrusted(JSON.stringify(result))
  } catch {
    return result
  }
}
