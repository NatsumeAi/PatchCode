/**
 * True when the model responded with the NO_REPLY sentinel.
 * Grok-style: strip non-alphanumerics and lowercase so
 * "no_reply" / "no reply" / "No-Reply" / "noreply" all match.
 */
export function isNoReply(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")
  return normalized === "noreply"
}

/**
 * Strip common model wrappers (markdown fences, leading fences) before treating
 * content as MEMORY.md / flush body.
 */
export function stripModelWrapper(text: string): string {
  let t = text.trim()
  const fenced = t.match(/^```(?:[a-zA-Z0-9_-]*)?\s*\n([\s\S]*?)\n```\s*$/)
  if (fenced) t = fenced[1]!.trim()
  if (t.startsWith("```")) {
    const nl = t.indexOf("\n")
    if (nl !== -1) t = t.slice(nl + 1)
    if (t.endsWith("```")) t = t.slice(0, -3).trimEnd()
  }
  return t.trim()
}

/** Soft quality gate: durable archive should look like markdown (headers or lists). */
export function hasMarkdownStructure(text: string): boolean {
  return /^#{1,6}\s/m.test(text) || /^[-*]\s/m.test(text)
}
