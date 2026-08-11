import { Effect, Option } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { readTextSafe, type MemoryRoots } from "./storage"
import type { MemoryIndex } from "./reindex"
import { selectPruneCandidates } from "./prune"
import {
  getMemoryStats,
  hydrateFlushStats,
  loadConsolidateStatus,
  type ConsolidateStatus,
  type MemoryStats,
  type PersistedConsolidateStatus,
} from "./observability"
import { memoryCitationsMode, memoryEmbeddingEnvConfig, memoryDreamHoursEnvConfig, memoryRecallEnvConfig, type CitationsMode } from "./config"
import { loadDreamStamps, type DreamPhaseStamps } from "./merge-lock"
import { selectDuePhase } from "./dream-phases"

export interface MemoryHealth {
  readonly files: number
  readonly totalBytes: number
  readonly chunks: number
  readonly bySource: Record<"global" | "workspace" | "session", number>
  readonly zeroAccessChunks: number
  readonly pruneCandidates: number
  readonly lastConsolidatedAt?: number
  /** Process-local + persisted consolidate status (optional for backward compat). */
  readonly lastConsolidateStatus?: ConsolidateStatus
  readonly lastConsolidateReason?: string
  readonly flushSuccess?: number
  readonly flushNoReply?: number
  readonly flushFailed?: number
  readonly sourcesMerged?: number
  /** Hybrid embedding status for operators. */
  readonly hybridEnabled?: boolean
  readonly hybridModel?: string
  /** Chunks with non-null vectors / total chunks (0–1). */
  readonly vectorCoverage?: number
  /** Human-readable next action when status is failed/skipped. */
  readonly actionHint?: string
  /** Last dream-phase run timestamps (ms epoch) from dream-phase.last.json. */
  readonly dreamLastLight?: number
  readonly dreamLastDeep?: number
  readonly dreamLastRem?: number
  /** Human-readable next dream phase, e.g. "light due now" or "deep due in ~2h". */
  readonly dreamNextHint?: string
  /** Recall filter: max age in days for recalled chunks (OPENCODE_MEMORY_RECALL_MAX_AGE_DAYS). */
  readonly recallMaxAgeDays?: number
  /** Recall filter: min relevance score for recalled chunks (OPENCODE_MEMORY_RECALL_MIN_SCORE). */
  readonly recallMinScore?: number
  /** Citation/injection mode; "auto" unless OPENCODE_MEMORY_CITATIONS is set. */
  readonly citationsMode?: CitationsMode
}

const walkMarkdown = (fs: FSUtil.Interface, dir: string): Effect.Effect<{ files: number; totalBytes: number }> =>
  Effect.gen(function* () {
    let files = 0
    let totalBytes = 0
    const walk = (current: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entries = yield* fs.readDirectoryEntries(current).pipe(Effect.catch(() => Effect.succeed([])))
        for (const entry of entries) {
          const full = path.join(current, entry.name)
          if (entry.type === "directory") {
            yield* walk(full)
          } else if (entry.type === "file" && entry.name.endsWith(".md")) {
            files++
            const info = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (info) totalBytes += Number(info.size)
          }
        }
      })
    yield* walk(dir)
    return { files, totalBytes }
  })

/** Bases to walk for dual-root health (global always; workspace when open). */
export function healthBases(roots: MemoryRoots): string[] {
  if (roots.workspaceDir !== undefined) return [roots.globalDir, roots.workspaceDir]
  return [roots.globalDir]
}

/**
 * Curated-memory health in [0,1] for the recovery gate: 1.0 only when both
 * MEMORY.md and memory_summary.md exist with content; 0 when either is missing
 * or empty so a wiped archive triggers recovery immediately.
 */
export const curatedHealth = Effect.fn("Memory.curatedHealth")(function* (fs: FSUtil.Interface, base: string) {
  const archive = yield* readTextSafe(fs, path.join(base, "MEMORY.md"))
  if (archive === undefined || archive.trim() === "") return 0
  const summary = yield* readTextSafe(fs, path.join(base, "memory_summary.md"))
  if (summary === undefined || summary.trim() === "") return 0
  return 1
})

/**
 * Prefer process-local stats when they have been recorded this process;
 * otherwise fall back to the most recent persisted status across bases.
 */
export const resolveConsolidateObservability = Effect.fn("Memory.resolveConsolidateObservability")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
) {
  // Cold start: restore flush counters from disk so restarts do not undercount.
  for (const base of healthBases(roots)) {
    yield* hydrateFlushStats(fs, base)
  }
  const local = getMemoryStats()
  if (local.lastConsolidateStatus !== "never") {
    return {
      lastConsolidateAt: local.lastConsolidateAt,
      lastConsolidateStatus: local.lastConsolidateStatus,
      lastConsolidateReason: local.lastConsolidateReason,
      flushSuccess: local.flushSuccess,
      flushNoReply: local.flushNoReply,
      flushFailed: local.flushFailed,
      sourcesMerged: local.sourcesMerged,
    } satisfies Partial<MemoryStats> & {
      lastConsolidateStatus: ConsolidateStatus
      flushSuccess: number
      flushNoReply: number
      flushFailed: number
      sourcesMerged: number
    }
  }
  let best: PersistedConsolidateStatus | undefined
  for (const base of healthBases(roots)) {
    const loaded = yield* loadConsolidateStatus(fs, base)
    if (loaded.lastConsolidateStatus === "never") continue
    if (
      best === undefined ||
      (loaded.lastConsolidateAt ?? 0) > (best.lastConsolidateAt ?? 0)
    ) {
      best = loaded
    }
  }
  return {
    lastConsolidateAt: best?.lastConsolidateAt,
    lastConsolidateStatus: best?.lastConsolidateStatus ?? ("never" as const),
    lastConsolidateReason: best?.lastConsolidateReason,
    flushSuccess: local.flushSuccess,
    flushNoReply: local.flushNoReply,
    flushFailed: local.flushFailed,
    sourcesMerged: local.sourcesMerged,
  }
})

/** Aggregates memory usage from the filesystem and the derived index. */
export const collectHealth = Effect.fn("Memory.collectHealth")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  index: MemoryIndex,
) {
  let files = 0
  let totalBytes = 0
  for (const base of healthBases(roots)) {
    const walked = yield* walkMarkdown(fs, base)
    files += walked.files
    totalBytes += walked.totalBytes
  }
  const chunkRows = yield* index.listChunks().pipe(Effect.catch(() => Effect.succeed([])))
  const bySource = { global: 0, workspace: 0, session: 0 }
  let zeroAccessChunks = 0
  let withVectors = 0
  for (const row of chunkRows) {
    bySource[row.source as "global" | "workspace" | "session"]++
    if (row.accessCount === 0) zeroAccessChunks++
    if (row.vectors !== undefined && row.vectors.length > 0) withVectors++
  }
  const embedCfg = memoryEmbeddingEnvConfig()
  const hybridEnabled = embedCfg !== undefined
  const vectorCoverage = chunkRows.length === 0 ? 0 : withVectors / chunkRows.length
  const pruneCandidates = selectPruneCandidates(
    chunkRows.map((row) => ({
      chunkId: String(row.id),
      path: row.path,
      excerpt: row.text.slice(0, 120),
      accessCount: row.accessCount,
      mtimeMs: row.mtimeMs,
    })),
    Date.now(),
  ).length

  // Prefer consolidation.last mtime from either base (dual-root).
  let lastConsolidatedAt: number | undefined
  for (const base of healthBases(roots)) {
    const last = yield* fs
      .stat(path.join(base, "consolidation.last"))
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (last !== undefined) {
      const ts = Option.getOrElse(last.mtime, () => new Date(0)).getTime()
      if (lastConsolidatedAt === undefined || ts > lastConsolidatedAt) lastConsolidatedAt = ts
    }
  }

  const obs = yield* resolveConsolidateObservability(fs, roots)
  // Prefer process-local / persisted lastConsolidateAt when newer than consolidation.last.
  const obsAt = obs.lastConsolidateAt
  if (obsAt !== undefined && (lastConsolidatedAt === undefined || obsAt > lastConsolidatedAt)) {
    lastConsolidatedAt = obsAt
  }

  const actionHint = (() => {
    const status = obs.lastConsolidateStatus
    const reason = obs.lastConsolidateReason
    if (status === "failed" && reason === "no-model") {
      return "Configure a default model provider — consolidation cannot run without a model."
    }
    if (status === "failed") {
      return `Consolidation failed${reason ? ` (${reason})` : ""}. Check logs; sources may be retained for retry.`
    }
    if (status === "skipped" && reason === "backoff") {
      return "Consolidation in backoff after hard failures; wait or clear consolidation.status.json."
    }
    if (hybridEnabled && vectorCoverage < 0.5 && chunkRows.length > 0) {
      return `Hybrid embedding on but only ${Math.round(vectorCoverage * 100)}% chunks have vectors — reindex/search will backfill on next query.`
    }
    if (!hybridEnabled) {
      return "Hybrid search off. Set OPENCODE_MEMORY_EMBEDDING_MODEL to enable vector ranking."
    }
    return undefined
  })()

  const stamps = yield* loadDreamStamps(fs, roots)
  const recallCfg = memoryRecallEnvConfig()

  return {
    files,
    totalBytes,
    chunks: chunkRows.length,
    bySource,
    zeroAccessChunks,
    pruneCandidates,
    ...(lastConsolidatedAt !== undefined ? { lastConsolidatedAt } : {}),
    lastConsolidateStatus: obs.lastConsolidateStatus,
    ...(obs.lastConsolidateReason !== undefined ? { lastConsolidateReason: obs.lastConsolidateReason } : {}),
    flushSuccess: obs.flushSuccess,
    flushNoReply: obs.flushNoReply,
    flushFailed: obs.flushFailed,
    sourcesMerged: obs.sourcesMerged,
    hybridEnabled,
    ...(embedCfg !== undefined ? { hybridModel: embedCfg.model } : {}),
    vectorCoverage,
    ...(actionHint !== undefined ? { actionHint } : {}),
    ...(stamps.light !== undefined ? { dreamLastLight: stamps.light } : {}),
    ...(stamps.deep !== undefined ? { dreamLastDeep: stamps.deep } : {}),
    ...(stamps.rem !== undefined ? { dreamLastRem: stamps.rem } : {}),
    dreamNextHint: dreamNextHint(Date.now(), stamps, memoryDreamHoursEnvConfig()),
    recallMaxAgeDays: recallCfg.maxAgeDays,
    recallMinScore: recallCfg.minScore,
    citationsMode: memoryCitationsMode(),
  } satisfies MemoryHealth
})

const HOUR_MS = 3600_000

/** Rough hours until the earliest next-due dream phase, e.g. "light due in ~2h". */
function dreamNextHint(
  now: number,
  stamps: DreamPhaseStamps,
  hours: { light: number; deep: number; rem: number },
): string {
  const due = selectDuePhase(now, stamps, hours)
  if (due !== undefined) return `${due} due now`
  const upcoming = (["light", "deep", "rem"] as const)
    .map((phase) => ({ phase, at: (stamps[phase] ?? now) + hours[phase] * HOUR_MS }))
    .reduce((earliest, entry) => (entry.at < earliest.at ? entry : earliest))
  return `${upcoming.phase} due in ~${Math.max(1, Math.round((upcoming.at - now) / HOUR_MS))}h`
}
