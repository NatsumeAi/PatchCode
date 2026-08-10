/**
 * Exact + near-duplicate gates for session flush content (Grok-style, no
 * embedding dependency). Exact uses sha256 of normalized body; near-duplicate
 * uses Jaccard over alphanumeric tokens.
 *
 * Threshold is 0.65 (not 0.92): token Jaccard is stricter than embedding cosine
 * at the same numeric value — 0.92 almost never fires for real paraphrases.
 */

export const FLUSH_NEAR_DUP_THRESHOLD = 0.65

export function normalizeFlushBody(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
}

export function flushContentHash(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(normalizeFlushBody(text))
  return hasher.digest("hex")
}

function tokens(text: string): Set<string> {
  return new Set(
    normalizeFlushBody(text)
      .split(/[^a-z0-9_]+/i)
      .filter((t) => t.length >= 2),
  )
}

export function jaccardSimilarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 && tb.size === 0) return 1
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const union = ta.size + tb.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * True when `candidate` is an exact or near-duplicate of `prior` flush body
 * (prior should be the previous ## Flush section without the header if possible).
 */
export function isFlushDuplicate(candidate: string, prior: string | undefined): boolean {
  if (prior === undefined || prior.trim() === "") return false
  // Strip ## Flush header if present for comparison.
  const priorBody = prior.replace(/^##\s*Flush\s*/i, "").trim()
  if (priorBody.length === 0) return false
  if (flushContentHash(candidate) === flushContentHash(priorBody)) return true
  return jaccardSimilarity(candidate, priorBody) >= FLUSH_NEAR_DUP_THRESHOLD
}
