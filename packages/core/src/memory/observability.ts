import { Effect } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { readTextSafe, writeTextAtomic } from "./storage"

export type ConsolidateStatus = "completed" | "nothing" | "skipped" | "failed" | "never"

export interface MemoryStats {
  readonly lastConsolidateAt?: number
  readonly lastConsolidateStatus: ConsolidateStatus
  readonly lastConsolidateReason?: string
  readonly flushSuccess: number
  readonly flushNoReply: number
  readonly flushFailed: number
  readonly sourcesMerged: number
}

const STATUS_FILE = "consolidation.status.json"

/** Process-local counters (FULL bar). Last consolidate status may also be persisted per base. */
const stats: {
  lastConsolidateAt?: number
  lastConsolidateStatus: ConsolidateStatus
  lastConsolidateReason?: string
  flushSuccess: number
  flushNoReply: number
  flushFailed: number
  sourcesMerged: number
} = {
  lastConsolidateStatus: "never",
  flushSuccess: 0,
  flushNoReply: 0,
  flushFailed: 0,
  sourcesMerged: 0,
}

/** Snapshot of process-local memory observability counters. */
export function getMemoryStats(): MemoryStats {
  return {
    lastConsolidateAt: stats.lastConsolidateAt,
    lastConsolidateStatus: stats.lastConsolidateStatus,
    lastConsolidateReason: stats.lastConsolidateReason,
    flushSuccess: stats.flushSuccess,
    flushNoReply: stats.flushNoReply,
    flushFailed: stats.flushFailed,
    sourcesMerged: stats.sourcesMerged,
  }
}

/** Test-only: reset counters between cases. */
export function resetMemoryStatsForTests(): void {
  stats.lastConsolidateAt = undefined
  stats.lastConsolidateStatus = "never"
  stats.lastConsolidateReason = undefined
  stats.flushSuccess = 0
  stats.flushNoReply = 0
  stats.flushFailed = 0
  stats.sourcesMerged = 0
  failureBackoffByBase.clear()
}

// Per-base consecutive failure backoff for over-cap / threat / atomic / ledger.
const failureBackoffByBase = new Map<string, { count: number; skipUntil: number }>()

/** True when this base should skip consolidate due to recent consecutive failures. */
export function shouldSkipConsolidateBackoff(baseDir: string, now = Date.now()): boolean {
  const entry = failureBackoffByBase.get(baseDir)
  if (entry === undefined) return false
  return now < entry.skipUntil
}

/** Record a hard merge failure; exponential backoff after 2+ consecutive failures (max 4h). */
export function recordConsolidateHardFailure(baseDir: string, now = Date.now()): void {
  const prev = failureBackoffByBase.get(baseDir)
  const count = (prev?.count ?? 0) + 1
  // 30min * 2^(count-2) after second failure, capped at 4h
  const minutes = count <= 1 ? 0 : Math.min(240, 30 * 2 ** Math.min(count - 2, 3))
  failureBackoffByBase.set(baseDir, { count, skipUntil: now + minutes * 60_000 })
}

/** Clear failure backoff after a successful merge or clean nothing-to-do. */
export function clearConsolidateBackoff(baseDir: string): void {
  failureBackoffByBase.delete(baseDir)
}

export function recordFlushSuccess(): void {
  stats.flushSuccess++
}

export function recordFlushNoReply(): void {
  stats.flushNoReply++
}

export function recordFlushFailed(reason?: string): void {
  stats.flushFailed++
  void reason
}

/** Higher = more important for dual-root rollup (workspace then global). */
const CONSOLIDATE_STATUS_RANK: Record<ConsolidateStatus, number> = {
  never: 0,
  nothing: 1,
  skipped: 2,
  failed: 3,
  completed: 4,
}

/**
 * Record a consolidate outcome. Dual-root runs call this twice (workspace then
 * global); a later "nothing" must not overwrite an earlier "completed".
 */
export function recordConsolidate(input: {
  readonly status: Exclude<ConsolidateStatus, "never">
  readonly reason?: string
  readonly sourcesMerged?: number
}): void {
  if (input.sourcesMerged !== undefined && input.sourcesMerged > 0) {
    stats.sourcesMerged += input.sourcesMerged
  }
  const prev = stats.lastConsolidateStatus
  const nextRank = CONSOLIDATE_STATUS_RANK[input.status]
  const prevRank = CONSOLIDATE_STATUS_RANK[prev]
  // Never demote completed → nothing/skipped; keep the stronger status.
  if (nextRank < prevRank) {
    stats.lastConsolidateAt = Date.now()
    return
  }
  stats.lastConsolidateAt = Date.now()
  stats.lastConsolidateStatus = input.status
  stats.lastConsolidateReason = input.reason
}
export function statusFilePath(baseDir: string): string {
  return path.join(baseDir, STATUS_FILE)
}

/**
 * Persist last consolidate outcome under the memory base dir so health can
 * surface it after process restart (process counters still reset).
 */
export const persistConsolidateStatus = Effect.fn("Memory.persistConsolidateStatus")(function* (
  fs: FSUtil.Interface,
  baseDir: string,
  status: Exclude<ConsolidateStatus, "never">,
  reason?: string,
) {
  const payload = JSON.stringify({
    lastConsolidateAt: Date.now(),
    lastConsolidateStatus: status,
    ...(reason !== undefined ? { lastConsolidateReason: reason } : {}),
  })
  return yield* writeTextAtomic(fs, statusFilePath(baseDir), payload)
})

export interface PersistedConsolidateStatus {
  readonly lastConsolidateAt?: number
  readonly lastConsolidateStatus: ConsolidateStatus
  readonly lastConsolidateReason?: string
}

/** Load persisted consolidation status from a base dir; falls back to never. */
export const loadConsolidateStatus = Effect.fn("Memory.loadConsolidateStatus")(function* (
  fs: FSUtil.Interface,
  baseDir: string,
) {
  const text = yield* readTextSafe(fs, statusFilePath(baseDir))
  if (text === undefined || text.trim() === "") {
    return { lastConsolidateStatus: "never" as const } satisfies PersistedConsolidateStatus
  }
  try {
    const parsed = JSON.parse(text) as {
      lastConsolidateAt?: number
      lastConsolidateStatus?: ConsolidateStatus
      lastConsolidateReason?: string
    }
    const status = parsed.lastConsolidateStatus
    if (
      status !== "completed" &&
      status !== "nothing" &&
      status !== "skipped" &&
      status !== "failed" &&
      status !== "never"
    ) {
      return { lastConsolidateStatus: "never" as const } satisfies PersistedConsolidateStatus
    }
    return {
      lastConsolidateAt: typeof parsed.lastConsolidateAt === "number" ? parsed.lastConsolidateAt : undefined,
      lastConsolidateStatus: status,
      lastConsolidateReason:
        typeof parsed.lastConsolidateReason === "string" ? parsed.lastConsolidateReason : undefined,
    } satisfies PersistedConsolidateStatus
  } catch {
    return { lastConsolidateStatus: "never" as const } satisfies PersistedConsolidateStatus
  }
})
