import path from "path"
import { Effect, Option } from "effect"
import { FSUtil } from "../fs-util"
import type { MemoryRoots } from "./storage"

export const STALE_LOCK_SECS = 3600
const MIN_CONSOLIDATION_HOURS = 4

const baseDir = (roots: MemoryRoots) => roots.workspaceDir ?? roots.globalDir
const lockPath = (roots: MemoryRoots) => path.join(baseDir(roots), "consolidation.lock")
const lastPath = (roots: MemoryRoots) => path.join(baseDir(roots), "consolidation.last")

const fileMtime = (fs: FSUtil.Interface, file: string): Effect.Effect<number | undefined> =>
  fs.stat(file).pipe(
    Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
    Effect.orElseSucceed(() => undefined),
  )

/** Acquires the exclusive consolidation lock; stale locks (>= 3600s) are reclaimed. */
export const acquireMergeLock = Effect.fn("Memory.acquireMergeLock")(function* (fs: FSUtil.Interface, roots: MemoryRoots) {
  const target = lockPath(roots)
  const tryCreate = (): Effect.Effect<boolean> =>
    fs.ensureDir(path.dirname(target)).pipe(
      Effect.andThen(fs.writeFileString(target, String(Date.now()), { flag: "wx" })),
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false)),
    )
  const acquired = yield* tryCreate()
  if (acquired) return true
  const mtime = yield* fileMtime(fs, target)
  if (mtime === undefined || Date.now() - mtime < STALE_LOCK_SECS * 1000) return false

  // Atomic reclaim: rename the stale lock to a unique graveyard path. Only one
  // process can win the rename; losers fail with a missing source and retry.
  const graveyard = `${target}.reclaim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const won = yield* fs.rename(target, graveyard).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }))
  if (!won) return yield* tryCreate()
  // Re-validate the moved lock: a live holder may have refreshed it between our
  // staleness check and the rename. Restore it and back off instead of stealing.
  const movedMtime = yield* fileMtime(fs, graveyard)
  if (movedMtime !== undefined && Date.now() - movedMtime < STALE_LOCK_SECS * 1000) {
    yield* fs.rename(graveyard, target).pipe(Effect.catch(() => Effect.void))
    return false
  }
  yield* fs.remove(graveyard).pipe(Effect.catch(() => Effect.void))
  return yield* tryCreate()
})

export const releaseMergeLock = Effect.fn("Memory.releaseMergeLock")(function* (fs: FSUtil.Interface, roots: MemoryRoots) {
  yield* fs.remove(lockPath(roots)).pipe(Effect.catch(() => Effect.void))
})

/**
 * Heartbeat: refreshes the lock file's mtime so a long-running merge cannot be
 * mistaken for a stale lock and reclaimed by another process mid-flight.
 */
export const refreshMergeLock = Effect.fn("Memory.refreshMergeLock")(function* (fs: FSUtil.Interface, roots: MemoryRoots) {
  yield* fs.ensureDir(path.dirname(lockPath(roots))).pipe(Effect.andThen(fs.writeFileString(lockPath(roots), String(Date.now())))).pipe(
    Effect.catch(() => Effect.void),
  )
})

/** Records the timestamp of a completed consolidation. */
export const markConsolidated = Effect.fn("Memory.markConsolidated")(function* (fs: FSUtil.Interface, roots: MemoryRoots) {
  const target = lastPath(roots)
  yield* fs.ensureDir(path.dirname(target)).pipe(Effect.andThen(fs.writeFileString(target, String(Date.now())))).pipe(
    Effect.catch(() => Effect.void),
  )
})

/** Last consolidation time, or undefined when none happened yet. */
export const lastConsolidatedAt = Effect.fn("Memory.lastConsolidatedAt")(function* (fs: FSUtil.Interface, roots: MemoryRoots) {
  return yield* fileMtime(fs, lastPath(roots))
})

/** True when a consolidation may run again (older than the min interval). */
export const shouldConsolidate = Effect.fn("Memory.shouldConsolidate")(function* (fs: FSUtil.Interface, roots: MemoryRoots) {
  const last = yield* lastConsolidatedAt(fs, roots)
  if (last === undefined) return true
  return Date.now() - last >= MIN_CONSOLIDATION_HOURS * 60 * 60 * 1000
})
