export const THREAT_PATTERNS = [
  {
    id: "inject_ignore",
    re: /ignore\s+(?:(?:all|any|the)\s+)?(?:previous|above|below|prior)\s+instructions/i,
    reason: "instruction override",
  },
  {
    id: "inject_override",
    re: /(disregard|forget|ignore)\s+(?:(?:all|any|the|your)\s+)*(?:previous\s+)?(instructions|system\s*prompt|guidelines|directives)/i,
    reason: "system prompt override",
  },
  {
    id: "inject_role",
    re: /you(?:\s+are|'re)\s+(?:now\s+)?an?\s+(unrestricted|jailbroken|unfiltered)\s+(agent|assistant|model|ai)/i,
    reason: "role hijack",
  },
  {
    id: "exfil_api_key",
    re: /\b(sk|pk|ghp|gho|sl)[_-][A-Za-z0-9_-]{16,}\b/i,
    reason: "credential exfiltration",
  },
  {
    id: "exfil_secret",
    re: /\b(api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9._-]{12,}/i,
    reason: "credential exfiltration",
  },
] as const

/**
 * Returns the ids of all threat patterns matched in `text` (empty when clean).
 * Zero-width characters (U+200B–U+200D, U+FEFF) are normalized to spaces so
 * they cannot be used to smuggle past the word-boundary patterns.
 */
export function scanForThreats(text: string): string[] {
  const normalized = text.replace(/[\u200B-\u200D\uFEFF]/g, " ")
  return THREAT_PATTERNS.filter((pattern) => pattern.re.test(normalized)).map((pattern) => pattern.id)
}

/** Placeholder that replaces blocked content in injected summaries. */
export function BLOCK_PLACEHOLDER(ids: string[]): string {
  return `[BLOCKED: memory entry contained threat pattern(s): ${ids.join(", ")}. Removed from system prompt.]`
}
