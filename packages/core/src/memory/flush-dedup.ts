/**
 * Exact + near-duplicate gates for session flush content.
 * - Exact: sha256 of normalized body
 * - Near-dup: Jaccard over alphanumeric tokens (threshold 0.65)
 * - Optional cosine: when embedding vectors are available (threshold 0.92),
 *   catches paraphrases that token Jaccard misses.
 */

export const FLUSH_NEAR_DUP_THRESHOLD = 0.65
/** Cosine threshold for embedding-based near-dup (only when both vectors present). */
export const FLUSH_COSINE_DUP_THRESHOLD = 0.92

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

/** Cosine similarity of two equal-length vectors; 0 if empty/mismatched. */
export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/**
 * True when `candidate` is an exact or near-duplicate of `prior` flush body
 * (prior should be the previous ## Flush section without the header if possible).
 * Optional embedding vectors enable cosine near-dup at 0.92.
 */
export function isFlushDuplicate(
  candidate: string,
  prior: string | undefined,
  vectors?: { candidate?: ReadonlyArray<number>; prior?: ReadonlyArray<number> },
): boolean {
  if (prior === undefined || prior.trim() === "") return false
  // Strip ## Flush header if present for comparison.
  const priorBody = prior.replace(/^##\s*Flush\s*/i, "").trim()
  if (priorBody.length === 0) return false
  if (flushContentHash(candidate) === flushContentHash(priorBody)) return true
  if (jaccardSimilarity(candidate, priorBody) >= FLUSH_NEAR_DUP_THRESHOLD) return true
  if (
    vectors?.candidate !== undefined &&
    vectors.prior !== undefined &&
    vectors.candidate.length > 0 &&
    vectors.candidate.length === vectors.prior.length
  ) {
    return cosineSimilarity(vectors.candidate, vectors.prior) >= FLUSH_COSINE_DUP_THRESHOLD
  }
  return false
}
