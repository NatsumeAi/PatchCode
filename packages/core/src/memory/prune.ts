export const PRUNE_ACCESS_THRESHOLD = 3
export const PRUNE_AGE_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export interface PruneInput {
  readonly chunkId: string
  readonly path: string
  readonly excerpt: string
  readonly accessCount: number
  readonly mtimeMs: number
}

/**
 * Curated archive paths must never appear on the automatic prune list —
 * only session notes / logs and other non-curated paths are candidates.
 */
export function isPrunablePath(filePath: string): boolean {
  const base = filePath.replace(/\\/g, "/")
  if (base === "MEMORY.md" || base === "memory_summary.md") return false
  if (base.endsWith("/MEMORY.md") || base.endsWith("/memory_summary.md")) return false
  return true
}

/** Chunks below the access threshold AND older than the age threshold become prune candidates. */
export function selectPruneCandidates(
  input: ReadonlyArray<PruneInput>,
  now: number,
): Array<{ chunkId: string; path: string; excerpt: string }> {
  return input
    .filter(
      (item) =>
        item.chunkId.length > 0 &&
        isPrunablePath(item.path) &&
        item.accessCount < PRUNE_ACCESS_THRESHOLD &&
        now - item.mtimeMs > PRUNE_AGE_DAYS * DAY_MS,
    )
    .map(({ chunkId, path, excerpt }) => ({ chunkId, path, excerpt }))
}

export const PRUNE_SYSTEM = `Additionally, process the PRUNE LIST of chunk excerpts:
- Match each excerpt against EXISTING MEMORY; if you cannot locate matching text, skip that entry.
- Only remove content that is clearly superseded, obsolete, or contradicted by newer facts.
- When in doubt, KEEP the content. Prefer retention over aggressive deletion.
- Do not delete unrelated sections. Keep the archive coherent and up to date.`
