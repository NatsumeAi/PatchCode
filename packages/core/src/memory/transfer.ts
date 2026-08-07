import path from "path"
import { Effect, Option } from "effect"
import { FSUtil } from "../fs-util"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"
import { scanForThreats } from "./scan"

export interface TransferManifest {
  readonly version: 1
  readonly exportedAt: string
  readonly scopes: Array<"global" | "workspace">
  readonly includeRaw: boolean
}

const CURATED_FILES = ["MEMORY.md", "memory_summary.md"]
const RAW_DIRS = ["extensions/ad_hoc/notes", "sessions"]

/** Exports curated memory (plus raw notes/sessions only with includeRaw) into a pack dir. */
export const exportMemory = Effect.fn("Memory.exportMemory")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  target: string,
  opts: { includeRaw?: boolean },
) {
  const includeRaw = opts.includeRaw ?? false
  const base = roots.workspaceDir ?? roots.globalDir
  const manifest: TransferManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    scopes: ["global"],
    includeRaw,
  }
  yield* writeTextAtomic(fs, path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2))
  for (const name of CURATED_FILES) {
    const text = yield* readTextSafe(fs, path.join(base, name))
    if (text !== undefined) yield* writeTextAtomic(fs, path.join(target, name), text)
  }
  if (includeRaw) {
    for (const dir of RAW_DIRS) {
      const entries = yield* fs.readDirectoryEntries(path.join(base, dir)).pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of entries) {
        if (entry.type !== "file") continue
        const text = yield* readTextSafe(fs, path.join(base, dir, entry.name))
        if (text !== undefined) yield* writeTextAtomic(fs, path.join(target, dir, entry.name), text)
      }
    }
  }
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
 */
export const importMemory = Effect.fn("Memory.importMemory")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  source: string,
) {
  const manifestText = yield* readTextSafe(fs, path.join(source, "manifest.json"))
  if (manifestText === undefined) return { imported: 0, skipped: 0 }
  const manifest = JSON.parse(manifestText) as TransferManifest
  const base = roots.workspaceDir ?? roots.globalDir
  let imported = 0
  let skipped = 0
  const copy = (relative: string): Effect.Effect<void, Error> =>
    Effect.gen(function* () {
      const text = yield* readTextSafe(fs, path.join(source, relative))
      if (text === undefined) return
      if (scanForThreats(text).length > 0) {
        skipped++
        return
      }
      const target = path.join(base, relative)
      const localMtime = yield* mtimeOf(fs, target)
      const srcMtime = yield* mtimeOf(fs, path.join(source, relative))
      const existing = yield* readTextSafe(fs, target)
      if (existing !== undefined && localMtime >= srcMtime) {
        skipped++
        return
      }
      yield* writeTextAtomic(fs, target, text)
      imported++
    })
  for (const name of CURATED_FILES) yield* copy(name)
  if (manifest.includeRaw) {
    for (const dir of RAW_DIRS) {
      const entries = yield* fs.readDirectoryEntries(path.join(source, dir)).pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of entries) if (entry.type === "file") yield* copy(path.join(dir, entry.name))
    }
  }
  return { imported, skipped }
})
