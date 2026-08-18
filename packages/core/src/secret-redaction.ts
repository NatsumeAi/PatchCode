export * as SecretRedaction from "./secret-redaction"

const MIN_SECRET_LENGTH = 8
const secrets = new Set<string>()

const variants = (raw: string): string[] => {
  const out = [raw]
  try {
    out.push(encodeURIComponent(raw))
  } catch {
    // ignore
  }
  try {
    const encoded = JSON.stringify(raw)
    if (encoded.startsWith('"') && encoded.endsWith('"')) out.push(encoded.slice(1, -1))
  } catch {
    // ignore
  }
  return out
}

/** Register a secret so later logs, tool output, and exports can strip it. Short values are ignored. */
export function registerSecretValue(raw: string | undefined | null): void {
  if (typeof raw !== "string") return
  if (raw.length < MIN_SECRET_LENGTH) return
  for (const variant of variants(raw)) {
    if (variant.length >= MIN_SECRET_LENGTH) secrets.add(variant)
  }
}

/** Replace registered secret substrings with a redaction token. */
export function redactSecrets(text: string): string {
  if (secrets.size === 0 || text.length === 0) return text
  let out = text
  for (const secret of secrets) {
    if (secret.length === 0 || !out.includes(secret)) continue
    out = out.split(secret).join("[REDACTED]")
  }
  return out
}

/** Recursively redact string leaves. Cycles become "[Circular]". */
export function redactUnknown(input: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof input === "string") return redactSecrets(input)
  if (input === null || typeof input !== "object") return input
  if (seen.has(input)) return "[Circular]"
  seen.add(input)
  if (Array.isArray(input)) return input.map((item) => redactUnknown(item, seen))
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, redactUnknown(value, seen)]))
}

/** Test-only: drop the registered secret set. */
export function resetSecretsForTests(): void {
  secrets.clear()
}
