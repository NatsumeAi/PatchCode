export const TEMPORAL_HALF_LIFE_DAYS = 7

const SCAFFOLD_MARKERS = [
  "Add project-specific knowledge here",
  "Add any cross-project preferences here",
  "Auto-populated by dream consolidation",
]

/** Structurally empty or short scaffold text should never surface in results. */
export function isContentFree(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  return trimmed.length < 200 && SCAFFOLD_MARKERS.some((marker) => trimmed.includes(marker))
}

/** Session chunks decay exponentially (half-life 7 days); curated sources are exempt. */
export function decayScore(score: number, ageDays: number, source: "global" | "workspace" | "session"): number {
  if (source !== "session") return score
  const lambda = Math.LN2 / TEMPORAL_HALF_LIFE_DAYS
  return score * Math.exp(-lambda * ageDays)
}

export const STALE_AFTER_DAYS = 14

/** Display-only staleness note for old session chunks; curated sources are exempt. */
export function staleNote(ageDays: number, source: "global" | "workspace" | "session"): string {
  if (source !== "session") return ""
  if (ageDays <= STALE_AFTER_DAYS) return ""
  return `(memory from ${Math.round(ageDays)} days ago, may be stale — verify before relying)`
}

export const DEFAULT_RECALL_MAX_AGE_DAYS = 30
export const DEFAULT_RECALL_MIN_SCORE = 0.15

export type RecallHitLike = {
  path: string
  score: number
  source: string
  ageDays: number
  text: string
}

export function filterRecallHits<T extends RecallHitLike>(
  items: ReadonlyArray<T>,
  opts: { maxAgeDays: number; minScore: number },
): T[] {
  return items.filter((item) => {
    // Age + minScore gates are session-only:
    // - Curated (workspace/global) FTS ranks use raw -bm25 values that often sit
    //   near 0 even for the best hit — a 0–1 floor would drop real MEMORY.md hits.
    // - Hybrid search already applies DEFAULT_MIN_SCORE (0.35) before results
    //   reach this filter; session decay can still push ranks below minScore.
    // Unknown / non-finite age or score fails open (kept).
    if (item.source !== "session") return true
    const age = item.ageDays
    if (Number.isFinite(age) && age > opts.maxAgeDays) return false
    if (Number.isFinite(item.score) && item.score < opts.minScore) return false
    return true
  })
}

export type Rankable = { path: string; score: number; source: string; ageDays: number }

const sourceRank = { workspace: 0, global: 1, session: 2 } as const

/** Sorts by decayed score desc; curated (workspace > global) before session on ties. */
export function rankResults<T extends Rankable>(items: ReadonlyArray<T>): Array<T> {
  const decayed = items.map((item) => ({ item, score: decayScore(item.score, item.ageDays, item.source as keyof typeof sourceRank) }))
  decayed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return sourceRank[a.item.source as keyof typeof sourceRank] - sourceRank[b.item.source as keyof typeof sourceRank]
  })
  return decayed.map(({ item }) => item)
}
