import type { MergeSource } from "./sources"

/**
 * Dream-phase policy for memory consolidation, aligned with openclaw's
 * dreaming: light merges run often with a small recent input, deep merges
 * promote only well-accessed recent content, rem mines patterns without
 * deleting anything, and recovery forces a light merge when curated memory
 * health drops below a threshold.
 *
 * This module is pure and synchronous: no LLM, no I/O. Callers supply the
 * current timestamp for phase selection and policy values for source gates.
 */
export type DreamPhase = "light" | "deep" | "rem" | "recovery"

export type PhasePolicy = {
  phase: DreamPhase
  /** Jaccard near-dup gate for light-only dedupe-only merges (0.9 openclaw-like). */
  dedupeThreshold: number
  /** Deep/rem: require accessCount >= N for session/candidate promotion when metadata present. */
  minAccess: number
  /** Deep/light: prefer sources newer than half-life days; older sessions are cold noise. */
  recencyHalfLifeDays: number
  /** Deep: min internal relevance score when available. */
  minScore: number
}

export const DEFAULT_DREAM_HOURS: { light: number; deep: number; rem: number } = {
  light: 6,
  deep: 24,
  rem: 168,
}

export const DEFAULT_DREAM_POLICY: PhasePolicy = {
  phase: "deep",
  dedupeThreshold: 0.9,
  minAccess: 3,
  recencyHalfLifeDays: 14,
  minScore: 0.8,
}

export const DEFAULT_RECOVERY_THRESHOLD = 0.35

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS

const PHASE_PRIORITY = ["light", "deep", "rem"] as const

/**
 * Returns the first due phase in priority order light → deep → rem, or
 * undefined when none are due. A phase is due when it has never run
 * (`last[phase]` undefined) or when `now - last[phase]` reaches its hour
 * interval. Recovery is never returned here — it is triggered separately via
 * `shouldRecover` and forces a light selection regardless of interval.
 */
export function selectDuePhase(
  now: number,
  last: { light?: number; deep?: number; rem?: number },
  hours: { light: number; deep: number; rem: number },
): DreamPhase | undefined {
  for (const phase of PHASE_PRIORITY) {
    const lastRun = last[phase]
    if (lastRun === undefined) return phase
    if (now - lastRun >= hours[phase] * HOUR_MS) return phase
  }
  return undefined
}

type MergeSourceWithAccess = MergeSource & { accessCount?: number }

/**
 * Selects the eligible subset of sources for a phase.
 *
 * - light/recovery: all notes and candidates, plus sessions recent enough to
 *   be inside the recency half-life (cold session noise stays on disk).
 * - deep: notes always eligible; sessions and candidates are gated on
 *   accessCount >= minAccess (when metadata is present) and recency.
 * - rem: notes plus high-access sessions/candidates; no recency gate and the
 *   REM path never deletes sources (Task 4 responsibility).
 *
 * Gates fail open: missing accessCount metadata or an uncomputable mtime
 * keeps the source rather than risking silent memory loss.
 */
export function filterSourcesForPhase(
  sources: ReadonlyArray<MergeSourceWithAccess>,
  phase: DreamPhase,
  policy: PhasePolicy,
  now: number = Date.now(),
): MergeSource[] {
  if (phase === "deep") return sources.filter((source) => passesDeep(source, policy, now))
  if (phase === "rem") return sources.filter((source) => passesRem(source, policy))
  return sources.filter((source) => passesLight(source, policy, now))
}

/**
 * Health in [0,1]; recovery is warranted when health drops below the
 * threshold while short-term sources still exist to rebuild from.
 */
export function shouldRecover(health: number, threshold: number, shortTermCount: number): boolean {
  return health < threshold && shortTermCount > 0
}

function passesLight(source: MergeSourceWithAccess, policy: PhasePolicy, now: number): boolean {
  if (source.kind === "note" || source.kind === "candidate") return true
  return isRecent(source, policy.recencyHalfLifeDays, now)
}

function passesDeep(source: MergeSourceWithAccess, policy: PhasePolicy, now: number): boolean {
  if (source.kind === "note") return true
  if (!meetsAccess(source.accessCount, policy.minAccess)) return false
  return isRecent(source, policy.recencyHalfLifeDays, now)
}

function passesRem(source: MergeSourceWithAccess, policy: PhasePolicy): boolean {
  if (source.kind === "note") return true
  return meetsAccess(source.accessCount, policy.minAccess)
}

function meetsAccess(accessCount: number | undefined, minAccess: number): boolean {
  if (accessCount === undefined) return true
  if (!Number.isFinite(accessCount)) return true
  return accessCount >= minAccess
}

// Recency is evaluated against an injectable `now` (defaulting to the current
// clock) so callers can freeze time, e.g. for deterministic tests; sources
// with an uncomputable mtime (non-finite or never-statted, i.e. 0) fail open
// and are kept.
function isRecent(source: MergeSourceWithAccess, halfLifeDays: number, now: number): boolean {
  if (!Number.isFinite(source.mtime) || source.mtime <= 0) return true
  return now - source.mtime < halfLifeDays * DAY_MS
}
