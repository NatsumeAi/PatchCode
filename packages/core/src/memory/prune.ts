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

/** Chunks below the access threshold AND older than the age threshold become prune candidates. */
export function selectPruneCandidates(
  input: ReadonlyArray<PruneInput>,
  now: number,
): Array<{ chunkId: string; path: string; excerpt: string }> {
  return input
    .filter(
      (item) =>
        item.chunkId.length > 0 &&
        item.accessCount < PRUNE_ACCESS_THRESHOLD &&
        now - item.mtimeMs > PRUNE_AGE_DAYS * DAY_MS,
    )
    .map(({ chunkId, path, excerpt }) => ({ chunkId, path, excerpt }))
}

export const PRUNE_SYSTEM =
  "Additionally, remove the listed chunk excerpts that are no longer relevant. Keep the archive coherent and up to date. Do not delete unrelated sections."
