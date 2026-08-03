import type { Part } from "@opencode-ai/sdk/v2"
import { toEpochMs } from "../util/epoch-ms"

/**
 * Transcript order for assistant parts.
 *
 * Live V2 parts use provider ids (`call_…`, `reasoning_…`, numeric stream ids)
 * that are NOT lexicographically time-ordered. Binary-inserting by part.id
 * put tools before reasoning when thinking finished and tools started in the
 * same turn — the UI showed tools above the thought that produced them.
 *
 * Sort key: start time (ms) → type rank (reasoning < text < tool < other) → id.
 */

function typeRank(part: Part): number {
  switch (part.type) {
    case "reasoning":
      return 0
    case "text":
      return 1
    case "tool":
      return 2
    default:
      return 3
  }
}

/** Best-effort start time for ordering; null if unknown. */
export function partStartMs(part: Part): number | null {
  if (part.type === "reasoning") return toEpochMs(part.time?.start)
  if (part.type === "text") return toEpochMs(part.time?.start)
  if (part.type === "tool") {
    const state = part.state
    if (state && typeof state === "object" && "time" in state) {
      const t = (state as { time?: { start?: unknown } }).time
      return toEpochMs(t?.start)
    }
  }
  return null
}

export type PartOrderKey = {
  t: number
  rank: number
  id: string
}

export function partOrderKey(part: Part): PartOrderKey {
  const t = partStartMs(part)
  return {
    // Untimed parts go last among unknown times but still group by type rank
    t: t ?? Number.MAX_SAFE_INTEGER,
    rank: typeRank(part),
    id: part.id,
  }
}

export function comparePartOrder(a: Part, b: Part): number {
  const ka = partOrderKey(a)
  const kb = partOrderKey(b)
  if (ka.t !== kb.t) return ka.t - kb.t
  if (ka.rank !== kb.rank) return ka.rank - kb.rank
  return ka.id < kb.id ? -1 : ka.id > kb.id ? 1 : 0
}

/**
 * Index at which `part` should be inserted into a list already ordered by
 * comparePartOrder. Binary search for O(log n).
 */
export function insertPartIndex(parts: readonly Part[], part: Part): number {
  let lo = 0
  let hi = parts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (comparePartOrder(parts[mid]!, part) <= 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Find existing part by id (linear — list is not id-sorted anymore). */
export function findPartIndex(parts: readonly Part[], partId: string): number {
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]!.id === partId) return i
  }
  return -1
}
