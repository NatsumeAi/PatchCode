import path from "path"
import { Effect, Option } from "effect"
import { FSUtil } from "../fs-util"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"

const MIN_SUBSTANTIVE_PROMPTS = 3
const MIN_USER_TEXT_BYTES = 50

/** Stale append-lock reclaim threshold (shorter than consolidation — appends are brief). */
export const APPEND_STALE_LOCK_SECS = 60

/** Sanitize session id for safe filenames: keep [A-Za-z0-9_-], replace the rest with `_`. */
export function sanitizeSessionId(sessionID: string): string {
  return sessionID.replace(/[^A-Za-z0-9_-]/g, "_")
}

/**
 * Dated session log path: `<root>/sessions/YYYY-MM-DD-<fullSanitizedSessionId>.md`.
 * Uses the full sanitized id (not last-8) so concurrent sessions never collide.
 */
export function sessionLogPath(roots: MemoryRoots, sessionID: string, when: Date): string {
  const day = when.toISOString().slice(0, 10)
  const safe = sanitizeSessionId(sessionID)
  const base = roots.workspaceDir ?? roots.globalDir
  return path.join(base, "sessions", `${day}-${safe}.md`)
}

const sessionsBase = (roots: MemoryRoots) => roots.workspaceDir ?? roots.globalDir
const appendLockPath = (roots: MemoryRoots) => path.join(sessionsBase(roots), "sessions", ".append.lock")

/** Trivial sessions (few prompts or little user text) are not worth capturing. */
export function isTrivialSession(input: { userPromptCount: number; userTextBytes: number }): boolean {
  return input.userPromptCount < MIN_SUBSTANTIVE_PROMPTS || input.userTextBytes < MIN_USER_TEXT_BYTES
}

// Serializes read-modify-write appends from the drain watcher and flush.
// Promise-chain mutex: the tail swap is synchronous (no yield between read
// and write), so concurrent fibers cannot each grab an empty chain and
// interleave the critical section (the old lazy Semaphore.make race).
let appendLockTail: Promise<void> = Promise.resolve()

const withAppendLock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    const prev = appendLockTail
    let release!: () => void
    appendLockTail = new Promise<void>((resolve) => {
      release = resolve
    })
    yield* Effect.promise(() => prev)
    try {
      return yield* effect
    } finally {
      release()
    }
  })

const fileMtime = (fs: FSUtil.Interface, file: string): Effect.Effect<number | undefined> =>
  fs.stat(file).pipe(
    Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
    Effect.orElseSucceed(() => undefined),
  )

/**
 * Best-effort exclusive file lock under `sessions/.append.lock` (wx + stale reclaim).
 * Mirrors merge-lock with a shorter stale window so multi-instance appends do not
 * interleave read-modify-write of the same dated session log.
 */
const acquireAppendFileLock = Effect.fn("Memory.acquireAppendFileLock")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
) {
  const target = appendLockPath(roots)
  const tryCreate = (): Effect.Effect<boolean> =>
    fs.ensureDir(path.dirname(target)).pipe(
      Effect.andThen(fs.writeFileString(target, String(Date.now()), { flag: "wx" })),
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false)),
    )
  const acquired = yield* tryCreate()
  if (acquired) return true
  const mtime = yield* fileMtime(fs, target)
  if (mtime === undefined || Date.now() - mtime < APPEND_STALE_LOCK_SECS * 1000) return false

  const graveyard = `${target}.reclaim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const won = yield* fs.rename(target, graveyard).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }))
  if (!won) return yield* tryCreate()
  const movedMtime = yield* fileMtime(fs, graveyard)
  if (movedMtime !== undefined && Date.now() - movedMtime < APPEND_STALE_LOCK_SECS * 1000) {
    yield* fs.rename(graveyard, target).pipe(Effect.catch(() => Effect.void))
    return false
  }
  yield* fs.remove(graveyard).pipe(Effect.catch(() => Effect.void))
  return yield* tryCreate()
})

const releaseAppendFileLock = Effect.fn("Memory.releaseAppendFileLock")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
) {
  yield* fs.remove(appendLockPath(roots)).pipe(Effect.catch(() => Effect.void))
})

/**
 * Appends a block to the session log, creating the dated file on first write.
 * Returns `true` when the atomic write succeeded, `false` on lock or write failure.
 */
export const appendSessionLog = Effect.fn("Memory.appendSessionLog")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  sessionID: string,
  when: Date,
  content: string,
) {
  return yield* withAppendLock(
    Effect.gen(function* () {
      const locked = yield* acquireAppendFileLock(fs, roots)
      if (!locked) {
        yield* Effect.logWarning(`memory append lock busy for session ${sessionID}`)
        return false
      }
      try {
        const file = sessionLogPath(roots, sessionID, when)
        // Treat any read failure (missing, EISDIR, permission) as empty so a
        // corrupt path fails the atomic write (boolean false) rather than
        // crashing the drain/flush path.
        const existing = yield* readTextSafe(fs, file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        const next = existing === undefined || existing === "" ? content : `${existing}\n\n---\n\n${content}`
        return yield* writeTextAtomic(fs, file, next).pipe(
          Effect.catch((error) =>
            Effect.logWarning(`memory append write failed for ${file}: ${String(error)}`).pipe(Effect.as(false)),
          ),
        )
      } finally {
        yield* releaseAppendFileLock(fs, roots)
      }
    }),
  )
})
