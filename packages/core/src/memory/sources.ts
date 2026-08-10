import path from "path"
import { Effect, Option } from "effect"
import { FSUtil } from "../fs-util"
import { readTextSafe, type MemoryRoots } from "./storage"

export type MergeSourceKind = "note" | "session" | "candidate"

export interface MergeSource {
  readonly kind: MergeSourceKind
  /** Stable id: `note:<filename>`, `session:<filename>`, or `cand:<filename>`. */
  readonly id: string
  readonly relativePath: string
  readonly absolutePath: string
  readonly text: string
  readonly mtime: number
}

const baseDir = (roots: MemoryRoots) => roots.workspaceDir ?? roots.globalDir

const notesDir = (roots: MemoryRoots) => path.join(baseDir(roots), "extensions", "ad_hoc", "notes")
const sessionsDir = (roots: MemoryRoots) => path.join(baseDir(roots), "sessions")
const candidatesDirOf = (roots: MemoryRoots) => path.join(baseDir(roots), "extensions", "ad_hoc", "candidates")

const kindPrefix = (kind: MergeSourceKind): string => {
  if (kind === "note") return "note"
  if (kind === "session") return "session"
  return "cand"
}

const relativeOf = (roots: MemoryRoots, absolute: string): string =>
  path.relative(baseDir(roots), absolute).replace(/\\/g, "/")

const listKind = Effect.fn("Memory.listMergeSourceKind")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  dir: string,
  kind: MergeSourceKind,
) {
  const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
  const items: Array<MergeSource> = []
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name.endsWith(".md")) continue
    const absolutePath = path.join(dir, entry.name)
    const text = yield* readTextSafe(fs, absolutePath)
    if (text === undefined) continue
    const info = yield* fs.stat(absolutePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const mtime = info ? Option.getOrElse(info.mtime, () => new Date(0)).getTime() : 0
    items.push({
      kind,
      id: `${kindPrefix(kind)}:${entry.name}`,
      relativePath: relativeOf(roots, absolutePath),
      absolutePath,
      text,
      mtime,
    })
  }
  return items.sort((a, b) => a.mtime - b.mtime || a.id.localeCompare(b.id))
})

/**
 * Collects mergeable memory sources under the active root, ordered notes →
 * sessions → candidates, each group sorted by mtime ascending (oldest first).
 */
export const listMergeSources = Effect.fn("Memory.listMergeSources")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
) {
  const notes = yield* listKind(fs, roots, notesDir(roots), "note")
  const sessions = yield* listKind(fs, roots, sessionsDir(roots), "session")
  const candidates = yield* listKind(fs, roots, candidatesDirOf(roots), "candidate")
  return [...notes, ...sessions, ...candidates]
})

/**
 * Takes sources in list order (already mtime-asc within kinds) until `maxChars`
 * of source text would be exceeded. Overflow stays on disk for the next run.
 */
export const budgetSources = (
  sources: ReadonlyArray<MergeSource>,
  maxChars: number,
): { included: MergeSource[]; overflow: MergeSource[] } => {
  const included: MergeSource[] = []
  const overflow: MergeSource[] = []
  let used = 0
  for (const source of sources) {
    const cost = source.text.length
    if (included.length > 0 && used + cost > maxChars) {
      overflow.push(source)
      continue
    }
    if (included.length === 0 && cost > maxChars) {
      // Always include at least one source even if over cap so a single huge
      // note is not permanently stuck; the LLM path caps the prompt separately.
      included.push(source)
      used += cost
      continue
    }
    if (used + cost > maxChars) {
      overflow.push(source)
      continue
    }
    included.push(source)
    used += cost
  }
  return { included, overflow }
}

/** Best-effort delete of source files; missing paths are ignored. */
export const deleteSources = Effect.fn("Memory.deleteSources")(function* (
  fs: FSUtil.Interface,
  sources: ReadonlyArray<MergeSource>,
) {
  for (const source of sources) {
    yield* fs.remove(source.absolutePath).pipe(Effect.catch(() => Effect.void))
  }
})

/** Delete a single source by absolute path (compat helper). */
export const deleteMergeSource = Effect.fn("Memory.deleteMergeSource")(function* (
  fs: FSUtil.Interface,
  absolutePath: string,
) {
  yield* fs.remove(absolutePath).pipe(Effect.catch(() => Effect.void))
})
