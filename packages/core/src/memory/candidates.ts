import path from "path"
import { Effect, Option } from "effect"
import { FSUtil } from "../fs-util"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"

export const NOISE_FLOOR_CHARS = 40

export const candidatesDir = (roots: MemoryRoots): string => {
  const base = roots.workspaceDir ?? roots.globalDir
  return path.join(base, "extensions", "ad_hoc", "candidates")
}

export const candidatePath = (roots: MemoryRoots, id: string): string =>
  path.join(candidatesDir(roots), `${id}.md`)

/** Stable idempotency key embedded in merged entries (sha256 hex of source + content). */
export const mergeKeyOf = (sourceId: string, content: string): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(`${sourceId}\n${content}`)
  return `<!-- memory-candidate:${hasher.digest("hex")} -->`
}

export const writeCandidate = Effect.fn("Memory.writeCandidate")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  id: string,
  content: string,
) {
  yield* writeTextAtomic(fs, candidatePath(roots, id), content)
})

export const listCandidates = Effect.fn("Memory.listCandidates")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  since: number,
) {
  const dir = candidatesDir(roots)
  const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
  const items: Array<{ id: string; path: string; mtime: number }> = []
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name.endsWith(".md")) continue
    const full = path.join(dir, entry.name)
    const info = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!info) continue
    const mtime = Option.getOrElse(info.mtime, () => new Date(0)).getTime()
    if (mtime < since) continue
    items.push({ id: entry.name.slice(0, -3), path: full, mtime })
  }
  return items.sort((a, b) => a.mtime - b.mtime)
})

export const readCandidate = Effect.fn("Memory.readCandidate")(function* (fs: FSUtil.Interface, roots: MemoryRoots, id: string) {
  return yield* readTextSafe(fs, candidatePath(roots, id))
})

export const deleteCandidate = Effect.fn("Memory.deleteCandidate")(function* (fs: FSUtil.Interface, roots: MemoryRoots, id: string) {
  yield* fs.remove(candidatePath(roots, id)).pipe(Effect.catch(() => Effect.void))
})
