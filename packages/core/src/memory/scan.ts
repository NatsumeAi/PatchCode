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
    id: "inject_system_role",
    re: /system\s*:\s*you\s+are\b/i,
    reason: "system role smuggle",
  },
  {
    id: "inject_html_comment",
    re: /<!--[\s\S]{0,80}ignore[\s\S]{0,80}instructions/i,
    reason: "html comment instruction smuggle",
  },
  {
    id: "inject_base64",
    // Long base64-looking blob only when adjacent to decode/ignore (avoids flagging normal docs).
    re: /(?:decode|ignore)[\s\S]{0,40}[A-Za-z0-9+/]{48,}={0,2}|[A-Za-z0-9+/]{48,}={0,2}[\s\S]{0,40}(?:decode|ignore)/i,
    reason: "encoded payload smuggle",
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
  {
    id: "exfil_slack",
    re: /\bxoxb-[A-Za-z0-9-]{10,}\b/,
    reason: "slack bot token",
  },
  {
    id: "exfil_aws",
    re: /\bAKIA[0-9A-Z]{16}\b/,
    reason: "aws access key id",
  },
  {
    id: "exfil_private_key",
    re: /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/,
    reason: "private key material",
  },
] as const

// Compile-time guard: keep the list reviewable (Hermes-inspired subset, ≤15).
const _maxPatterns: typeof THREAT_PATTERNS.length extends infer N
  ? N extends number
    ? N extends 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15
      ? true
      : never
    : never
  : never = true
void _maxPatterns

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
