import path from "path"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"
import { readTextSafe, writeTextAtomic } from "./storage"

const LEDGER_NAME = "merged.hashes"

export const mergedHashesPath = (baseDir: string) => path.join(baseDir, LEDGER_NAME)

/** Content hash for a merge source: sha256 hex of `id\\ntext`. */
export const contentHash = (id: string, text: string): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(`${id}\n${text}`)
  return hasher.digest("hex")
}

/** Loads the append-only hash ledger into a Set (empty when missing/unreadable). */
export const loadMergedHashes = Effect.fn("Memory.loadMergedHashes")(function* (
  fs: FSUtil.Interface,
  baseDir: string,
) {
  // Never defect the consolidation path on a corrupt ledger (directory, EACCES).
  const text = yield* readTextSafe(fs, mergedHashesPath(baseDir)).pipe(
    Effect.catch(() => Effect.succeed(undefined as string | undefined)),
  )
  if (text === undefined || text.trim() === "") return new Set<string>()
  const set = new Set<string>()
  for (const line of text.split("\n")) {
    const hash = line.trim()
    if (/^[a-f0-9]{64}$/i.test(hash)) set.add(hash.toLowerCase())
  }
  return set
})

/**
 * Appends new content hashes to `<base>/merged.hashes`. Returns whether the
 * atomic write succeeded. Deduplicates against existing ledger entries.
 */
export const appendMergedHashes = Effect.fn("Memory.appendMergedHashes")(function* (
  fs: FSUtil.Interface,
  baseDir: string,
  hashes: ReadonlyArray<string>,
) {
  if (hashes.length === 0) return true
  const existing = yield* loadMergedHashes(fs, baseDir)
  const fresh = hashes.map((h) => h.toLowerCase()).filter((h) => !existing.has(h))
  if (fresh.length === 0) return true
  const prior = yield* readTextSafe(fs, mergedHashesPath(baseDir))
  const body =
    prior === undefined || prior === ""
      ? `${fresh.join("\n")}\n`
      : `${prior.endsWith("\n") ? prior : `${prior}\n`}${fresh.join("\n")}\n`
  return yield* writeTextAtomic(fs, mergedHashesPath(baseDir), body)
})

export const isAlreadyMerged = (set: Set<string>, id: string, text: string): boolean =>
  set.has(contentHash(id, text))
