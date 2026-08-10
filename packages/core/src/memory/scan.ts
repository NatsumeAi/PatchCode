/**
 * Threat patterns for memory write/inject paths (Hermes-inspired, memory-strict).
 * Scope philosophy: memory enters the system prompt, so we prefer recall over
 * under-detection. Patterns still avoid flagging common engineering prose
 * (password fields, "system design", short base64 checksums).
 */

/** Cap scanned text so regex cost stays bounded on huge archives. */
export const MAX_SCAN_CHARS = 65_536

/** Bounded filler between attack keywords (Hermes-style obfuscation bypass). */
const FILLER = String.raw`(?:\w+\s+){0,8}`

export const THREAT_PATTERNS = [
  // ── Classic injection ─────────────────────────────────────────────
  {
    id: "inject_ignore",
    re: new RegExp(String.raw`ignore\s+${FILLER}(?:previous|all|above|prior|the)\s+${FILLER}instructions`, "i"),
    reason: "instruction override",
  },
  {
    id: "inject_override",
    re: new RegExp(
      String.raw`(disregard|forget|ignore)\s+${FILLER}(?:all|any|the|your|previous)?\s*${FILLER}(instructions|system\s*prompt|guidelines|directives|rules)`,
      "i",
    ),
    reason: "system prompt override",
  },
  {
    id: "inject_sys_override",
    re: /system\s+prompt\s+override/i,
    reason: "system prompt override phrase",
  },
  {
    id: "inject_role",
    re: new RegExp(
      String.raw`you(?:\s+are|'re)\s+${FILLER}(?:now\s+)?(?:an?\s+)?(unrestricted|jailbroken|unfiltered)\s+(agent|assistant|model|ai)`,
      "i",
    ),
    reason: "role hijack",
  },
  {
    id: "inject_role_now",
    re: new RegExp(String.raw`you\s+are\s+${FILLER}now\s+(?:a|an|the)\s+`, "i"),
    reason: "role reassignment",
  },
  {
    id: "inject_pretend",
    re: new RegExp(String.raw`pretend\s+${FILLER}(?:you\s+are|to\s+be)\s+`, "i"),
    reason: "role pretend",
  },
  {
    id: "inject_system_role",
    // Line-start or after newline so "system design: you are building…" stays clean.
    re: /(?:^|[\n\r])\s*system\s*:\s*you\s+are\b/im,
    reason: "system role smuggle",
  },
  {
    id: "inject_html_comment",
    re: /<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/i,
    reason: "html comment instruction smuggle",
  },
  {
    id: "inject_hidden_div",
    re: /<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none/i,
    reason: "hidden div smuggle",
  },
  {
    id: "inject_bypass",
    re: new RegExp(
      String.raw`act\s+as\s+(?:if|though)\s+${FILLER}you\s+${FILLER}(?:have\s+no|don't\s+have)\s+${FILLER}(?:restrictions|limits|rules)`,
      "i",
    ),
    reason: "bypass restrictions",
  },
  {
    id: "inject_remove_filters",
    re: new RegExp(
      String.raw`(?:respond|answer|reply)\s+without\s+${FILLER}(?:restrictions|limitations|filters|safety)`,
      "i",
    ),
    reason: "remove safety filters",
  },
  {
    id: "inject_deception",
    re: new RegExp(String.raw`do\s+not\s+${FILLER}tell\s+${FILLER}the\s+user`, "i"),
    reason: "deception hide from user",
  },
  {
    id: "inject_leak_prompt",
    re: new RegExp(String.raw`output\s+${FILLER}(?:system|initial)\s+prompt`, "i"),
    reason: "leak system prompt",
  },
  {
    id: "inject_base64",
    // Cap run length (48–256) to avoid catastrophic backtracking on long alnum prose.
    re: /(?:decode|ignore)\b[\s\S]{0,40}?[A-Za-z0-9+/]{48,256}={0,2}(?![A-Za-z0-9+/])|[A-Za-z0-9+/]{48,256}={0,2}(?![A-Za-z0-9+/])[\s\S]{0,40}?\b(?:decode|ignore)\b/i,
    reason: "encoded payload smuggle",
  },
  {
    id: "inject_translate_exec",
    re: /translate\s+[^\n]{0,200}\s+into\s+[^\n]{0,200}\s+and\s+(execute|run|eval)/i,
    reason: "translate-and-execute",
  },
  // ── Credential exfiltration ───────────────────────────────────────
  {
    id: "exfil_api_key",
    re: /\b(sk|pk|ghp|gho|sl)[_-][A-Za-z0-9_-]{16,}\b/i,
    reason: "credential exfiltration",
  },
  {
    id: "exfil_github_pat",
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    reason: "github fine-grained pat",
  },
  {
    id: "exfil_gitlab_pat",
    re: /\bglpat-[A-Za-z0-9_-]{16,}\b/,
    reason: "gitlab personal access token",
  },
  {
    id: "exfil_stripe_whsec",
    re: /\bwhsec_[A-Za-z0-9_-]{16,}\b/,
    reason: "stripe webhook secret",
  },
  {
    id: "exfil_google_api",
    re: /\bAIza[0-9A-Za-z_-]{20,}\b/,
    reason: "google api key",
  },
  {
    id: "exfil_google_oauth",
    re: /\bya29\.[0-9A-Za-z_-]{20,}\b/,
    reason: "google oauth access token",
  },
  {
    id: "exfil_aws_sts",
    re: /\bASIA[0-9A-Z]{16}\b/,
    reason: "aws temporary access key",
  },
  {
    id: "exfil_jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    reason: "jwt bearer token",
  },
  {
    id: "exfil_openai_sess",
    re: /\bsess-[A-Za-z0-9]{20,}\b/,
    reason: "openai session token",
  },
  {
    id: "exfil_runpod_key",
    re: /\brk_[A-Za-z0-9]{20,}\b/,
    reason: "runpod api key",
  },
  {
    id: "inject_c2_exfil",
    re: /(?:send|post|upload|exfiltrate)\s+[^\n]{0,120}\s+(?:to|via)\s+(?:https?:\/\/|webhook)/i,
    reason: "command-style data exfiltration",
  },
  {
    id: "exfil_secret",
    // Allow natural language "password is hunter2" as well as key=value forms.
    re: /\b(api[_-]?key|secret|password|token)\s*(?:[:=]|is)\s*['"]?[A-Za-z0-9._-]{8,}/i,
    reason: "credential assignment",
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
  {
    id: "exfil_curl",
    re: /curl\s+[^\n]{0,512}\$?\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i,
    reason: "curl secret exfiltration",
  },
] as const

/** Invisible / format-control chars used to smash word boundaries. */
const INVISIBLE_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD\u034F\u061C\u180E\u17B4\u17B5]/g

/**
 * Normalize text before pattern matching: NFKC (full-width Latin → ASCII), clamp.
 * Invisibles are handled in two variants inside `scanForThreats`:
 * - strip → empty: closes i\\u200Dgnore → ignore
 * - strip → space: closes ignore\\u200Bprevious → ignore previous
 */
export function normalizeForScan(text: string): string {
  const capped = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
  let normalized: string
  try {
    normalized = capped.normalize("NFKC")
  } catch {
    normalized = capped
  }
  // Default public form uses space (preserves multi-word boundaries).
  return normalized.replace(INVISIBLE_RE, " ")
}

function normalizeNfkc(text: string): string {
  const capped = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text
  try {
    return capped.normalize("NFKC")
  } catch {
    return capped
  }
}

/**
 * Returns the ids of all threat patterns matched in `text` (empty when clean).
 */
export function scanForThreats(text: string): string[] {
  const nfkc = normalizeNfkc(text)
  const spaced = nfkc.replace(INVISIBLE_RE, " ")
  const joined = nfkc.replace(INVISIBLE_RE, "")
  return THREAT_PATTERNS.filter((pattern) => pattern.re.test(spaced) || pattern.re.test(joined)).map(
    (pattern) => pattern.id,
  )
}

/**
 * Placeholder that replaces blocked content. Does not echo pattern ids so a
 * probing attacker cannot use the model as an oracle to iterate bypasses.
 */
export function BLOCK_PLACEHOLDER(_ids?: string[]): string {
  return `[BLOCKED: memory entry contained disallowed content. Removed from context.]`
}
