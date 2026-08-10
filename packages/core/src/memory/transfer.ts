import path from "path"
import { Effect, Option, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"
import { scanForThreats } from "./scan"

export interface TransferManifest {
  readonly version: 1
  readonly exportedAt: string
  readonly scopes: Array<"global" | "workspace">
  readonly includeRaw: boolean
}

export class SandboxError extends Schema.TaggedErrorClass<SandboxError>()("Memory.SandboxError", {
  target: Schema.String,
  reason: Schema.String,
}) {}

const CURATED_FILES = ["MEMORY.md", "memory_summary.md"]
const RAW_DIRS = ["extensions/ad_hoc/notes", "sessions"]

/**
 * Default roots for export/import packs: `globalData/memory-packs` plus optional
 * project directory (route workspace). Callers may pass a stricter list.
 */
export function defaultTransferAllowedRoots(globalData: string, projectDir?: string): string[] {
  const roots = [path.join(globalData, "memory-packs")]
  if (projectDir !== undefined && projectDir !== "") roots.push(projectDir)
  return roots
}

/**
 * Resolve realpath of `target` and require it to be contained in one of
 * `allowedRoots`. Fail closed when roots are empty or path escapes.
 */
export const assertSandboxPath = Effect.fn("Memory.assertSandboxPath")(function* (
  target: string,
  allowedRoots: ReadonlyArray<string>,
) {
  if (allowedRoots.length === 0) {
    return yield* new SandboxError({ target, reason: "no allowed roots" })
  }
  const resolved = FSUtil.resolve(target)
  for (const root of allowedRoots) {
    if (FSUtil.contains(FSUtil.resolve(root), resolved)) return resolved
  }
  return yield* new SandboxError({ target, reason: "path escapes sandbox" })
})

/**
 * Exports curated memory (plus raw notes/sessions only with includeRaw) into a
 * pack dir. Returns how many files were written successfully (atomics only).
 * `target` must be under one of `opts.allowedRoots` (realpath-checked).
 */
export const exportMemory = Effect.fn("Memory.exportMemory")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  target: string,
  opts: { includeRaw?: boolean; allowedRoots: ReadonlyArray<string> },
) {
  const safeTarget = yield* assertSandboxPath(target, opts.allowedRoots)
  const includeRaw = opts.includeRaw ?? false
  const base = roots.workspaceDir ?? roots.globalDir
  const manifest: TransferManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    scopes: [roots.workspaceDir !== undefined ? "workspace" : "global"],
    includeRaw,
  }
  let exported = 0
  if (yield* writeTextAtomic(fs, path.join(safeTarget, "manifest.json"), JSON.stringify(manifest, null, 2))) {
    exported++
  }
  for (const name of CURATED_FILES) {
    const text = yield* readTextSafe(fs, path.join(base, name))
    if (text === undefined) continue
    if (yield* writeTextAtomic(fs, path.join(safeTarget, name), text)) exported++
  }
  if (includeRaw) {
    for (const dir of RAW_DIRS) {
      const entries = yield* fs.readDirectoryEntries(path.join(base, dir)).pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of entries) {
        if (entry.type !== "file") continue
        const text = yield* readTextSafe(fs, path.join(base, dir, entry.name))
        if (text === undefined) continue
        if (yield* writeTextAtomic(fs, path.join(safeTarget, dir, entry.name), text)) exported++
      }
    }
  }
  return { exported }
})
const mtimeOf = (fs: FSUtil.Interface, file: string) =>
  fs.stat(file).pipe(
    Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
    Effect.orElseSucceed(() => 0),
  )

/**
 * Imports a memory pack. Never overwrites a local curated file that is newer
 * or equal; imports only when the local file is missing or the imported mtime
 * is strictly newer. Every imported file is threat-scanned.
 * `source` must be under one of `opts.allowedRoots` (realpath-checked).
 */
export const importMemory = Effect.fn("Memory.importMemory")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  source: string,
  opts: { force?: boolean; allowedRoots: ReadonlyArray<string> },
) {
  const force = opts.force ?? false
  const safeSource = yield* assertSandboxPath(source, opts.allowedRoots)
  const manifestText = yield* readTextSafe(fs, path.join(safeSource, "manifest.json"))
  if (manifestText === undefined) return { imported: 0, skipped: 0 }
  let manifest: TransferManifest
  try {
    manifest = JSON.parse(manifestText) as TransferManifest
  } catch {
    return { imported: 0, skipped: 0 }
  }
  const base = roots.workspaceDir ?? roots.globalDir
  let imported = 0
  let skipped = 0
  const copy = (relative: string): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const text = yield* readTextSafe(fs, path.join(safeSource, relative))
      if (text === undefined) return
      if (scanForThreats(text).length > 0) {
        skipped++
        return
      }
      const target = path.join(base, relative)
      const localMtime = yield* mtimeOf(fs, target)
      const srcMtime = yield* mtimeOf(fs, path.join(safeSource, relative))
      const existing = yield* readTextSafe(fs, target)
      if (!force && existing !== undefined && localMtime >= srcMtime) {
        skipped++
        return
      }
      const ok = yield* writeTextAtomic(fs, target, text)
      if (ok) imported++
      else skipped++
    })
  for (const name of CURATED_FILES) yield* copy(name)
  if (manifest.includeRaw) {
    for (const dir of RAW_DIRS) {
      const entries = yield* fs
        .readDirectoryEntries(path.join(safeSource, dir))
        .pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of entries) if (entry.type === "file") yield* copy(path.join(dir, entry.name))
    }
  }
  return { imported, skipped }
})
