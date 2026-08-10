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

const notesDir = (roots: MemoryRoots): string => {
  const base = roots.workspaceDir ?? roots.globalDir
  return path.join(base, "extensions", "ad_hoc", "notes")
}

const sessionsDir = (roots: MemoryRoots): string => {
  const base = roots.workspaceDir ?? roots.globalDir
  return path.join(base, "sessions")
}

export interface MergeSource {
  readonly id: string
  readonly path: string
  readonly text: string
}

/**
 * Lists every mergeable memory source under the active root: user notes
 * (extensions/ad_hoc/notes/), session logs (sessions/), and ad-hoc candidates
 * (extensions/ad_hoc/candidates/). These are the raw inputs consolidation
 * folds into MEMORY.md — the shipped path from the architecture doc
 * (notes/sessions -> candidates -> MEMORY.md), which the candidates-only
 * implementation previously left unconnected in production.
 */
export const listMergeSources = Effect.fn("Memory.listMergeSources")(function* (fs: FSUtil.Interface, roots: MemoryRoots) {
  const dirs = [notesDir(roots), sessionsDir(roots), candidatesDir(roots)]
  const sources: Array<MergeSource> = []
  for (const dir of dirs) {
    const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(".md")) continue
      const full = path.join(dir, entry.name)
      const text = yield* readTextSafe(fs, full)
      if (text === undefined) continue
      sources.push({ id: path.relative(roots.workspaceDir ?? roots.globalDir, full).replace(/\\/g, "/"), path: full, text })
    }
  }
  return sources
})

export const deleteMergeSource = Effect.fn("Memory.deleteMergeSource")(function* (fs: FSUtil.Interface, path: string) {
  yield* fs.remove(path).pipe(Effect.catch(() => Effect.void))
})
