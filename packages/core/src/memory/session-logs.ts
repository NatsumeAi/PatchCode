import path from "path"
import { Effect, Semaphore } from "effect"
import { FSUtil } from "../fs-util"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"

const MIN_SUBSTANTIVE_PROMPTS = 3
const MIN_USER_TEXT_BYTES = 50

/** Dated session log path: `<root>/sessions/YYYY-MM-DD-<sid8>.md`. */
export function sessionLogPath(roots: MemoryRoots, sessionID: string, when: Date): string {
  const day = when.toISOString().slice(0, 10)
  const sid8 = sessionID.slice(-8)
  const base = roots.workspaceDir ?? roots.globalDir
  return path.join(base, "sessions", `${day}-${sid8}.md`)
}

/** Trivial sessions (few prompts or little user text) are not worth capturing. */
export function isTrivialSession(input: { userPromptCount: number; userTextBytes: number }): boolean {
  return input.userPromptCount < MIN_SUBSTANTIVE_PROMPTS || input.userTextBytes < MIN_USER_TEXT_BYTES
}

// Serializes read-modify-write appends from the drain watcher and flush.
// The semaphore is created once and shared, so concurrent appends to the same
// dated file cannot lose blocks (a per-call semaphore would serialize nothing).
let appendLock: Semaphore.Semaphore | undefined
const withAppendLock = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const lock = appendLock ?? (appendLock = yield* Semaphore.make(1))
    return yield* lock.withPermits(1)(effect)
  })

/** Appends a block to the session log, creating the dated file on first write. */
export const appendSessionLog = Effect.fn("Memory.appendSessionLog")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  sessionID: string,
  when: Date,
  content: string,
) {
  yield* withAppendLock(
    Effect.gen(function* () {
      const file = sessionLogPath(roots, sessionID, when)
      const existing = yield* readTextSafe(fs, file)
      const next = existing === undefined || existing === "" ? content : `${existing}\n\n---\n\n${content}`
      yield* writeTextAtomic(fs, file, next)
    }),
  )
})
