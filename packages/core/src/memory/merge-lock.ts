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
  if (mtime !== undefined && Date.now() - mtime > STALE_LOCK_SECS * 1000) {
    yield* fs.remove(target).pipe(Effect.catch(() => Effect.void))
    return yield* tryCreate()
  }
  return false
})

export const releaseMergeLock = Effect.fn("Memory.releaseMergeLock")(function* (fs: FSUtil.Interface, roots: MemoryRoots) {
  yield* fs.remove(lockPath(roots)).pipe(Effect.catch(() => Effect.void))
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
