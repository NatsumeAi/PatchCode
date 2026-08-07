export const THREAT_PATTERNS = [
  {
    id: "inject_ignore",
    re: /ignore\s+(all\s+)?(previous|above|below|prior)\s+instructions/i,
    reason: "instruction override",
  },
  {
    id: "inject_override",
    re: /(disregard|forget|ignore)\s+(your|the)\s+(instructions|system prompt|guidelines)/i,
    reason: "system prompt override",
  },
  {
    id: "inject_role",
    re: /you\s+are\s+(?:now\s+)?an?\s+(unrestricted|jailbroken|unfiltered)\s+(agent|assistant|model|ai)/i,
    reason: "role hijack",
  },
  {
    id: "exfil_api_key",
    re: /\b(sk|pk|ghp|gho|sl)[_-][A-Za-z0-9]{16,}\b/,
    reason: "credential exfiltration",
  },
  {
    id: "exfil_secret",
    re: /\b(api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9._-]{12,}/i,
    reason: "credential exfiltration",
  },
] as const

/** Returns the ids of all threat patterns matched in `text` (empty when clean). */
export function scanForThreats(text: string): string[] {
  return THREAT_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.id)
}

/** Placeholder that replaces blocked content in injected summaries. */
export function BLOCK_PLACEHOLDER(ids: string[]): string {
  return `[BLOCKED: memory entry contained threat pattern(s): ${ids.join(", ")}. Removed from system prompt.]`
}
