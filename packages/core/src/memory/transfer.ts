import path from "path"
import { lstatSync, realpathSync } from "fs"
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
 * Deepest path prefix that exists (file, dir, or symlink). Does not follow the
 * final symlink for "exists" — lstat succeeds on the link itself.
 */
function deepestExistingPath(absolute: string): string {
  let cur = path.resolve(absolute)
  for (;;) {
    try {
      lstatSync(cur)
      return cur
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return cur
      cur = parent
    }
  }
}

/**
 * Resolve where a path would land after following symlinks on every existing
 * ancestor. Non-existent leaf components stay lexical under the realpath of
 * the deepest existing ancestor — so `sandbox/link/new` where `link` → `/out`
 * resolves to `/out/new`, not a lexical path still under the sandbox.
 *
 * This closes the ENOENT fallback hole in `FSUtil.resolve` (realpathSync fails
 * on missing leaves and returns the lexical path, which still appears inside
 * the sandbox while writes follow the intermediate symlink out).
 */
export function resolveSandboxEffectivePath(target: string): string {
  const absolute = path.resolve(target)
  const existing = deepestExistingPath(absolute)
  let realExisting: string
  try {
    realExisting = realpathSync(existing)
  } catch {
    // Broken symlink or unreadable — treat as non-existent parent walk.
    const parent = path.dirname(existing)
    try {
      realExisting = realpathSync(parent)
      const leaf = path.basename(existing)
      const rest = path.relative(existing, absolute)
      const via = path.join(realExisting, leaf, rest === "" ? "" : rest)
      return path.normalize(via)
    } catch {
      return absolute
    }
  }
  const rest = path.relative(existing, absolute)
  if (rest === "" || rest === ".") return path.normalize(realExisting)
  // rest must not escape via ".."
  if (rest === ".." || rest.startsWith(`..${path.sep}`) || path.isAbsolute(rest)) {
    return path.normalize(realExisting)
  }
  return path.normalize(path.join(realExisting, rest))
}

function realpathRoot(root: string): string {
  const abs = path.resolve(root)
  try {
    return realpathSync(abs)
  } catch {
    // Root may not exist yet (e.g. memory-packs). Use lexical absolute path.
    return abs
  }
}

/**
 * Resolve where `target` would land after following symlinks on existing
 * ancestors, and require that effective path to be contained in one of
 * `allowedRoots`. Fail closed when roots are empty or path escapes.
 */
export const assertSandboxPath = Effect.fn("Memory.assertSandboxPath")(function* (
  target: string,
  allowedRoots: ReadonlyArray<string>,
) {
  if (allowedRoots.length === 0) {
    return yield* new SandboxError({ target, reason: "no allowed roots" })
  }
  const effective = resolveSandboxEffectivePath(target)
  for (const root of allowedRoots) {
    if (FSUtil.contains(realpathRoot(root), effective)) return effective
  }
  return yield* new SandboxError({ target, reason: "path escapes sandbox" })
})

/** True when `file` exists and is a symbolic link (not followed). */
export function isSymlinkPath(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}
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
  // Dual-root: when workspace is open, export workspace curated at pack root and
  // global curated under global/; single-root keeps flat layout.
  const scopes: Array<"global" | "workspace"> =
    roots.workspaceDir !== undefined ? ["workspace", "global"] : ["global"]
  const manifest: TransferManifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    scopes,
    includeRaw,
  }
  let exported = 0
  if (yield* writeTextAtomic(fs, path.join(safeTarget, "manifest.json"), JSON.stringify(manifest, null, 2))) {
    exported++
  }
  const writeScope = (base: string, prefix: string): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      for (const name of CURATED_FILES) {
        const text = yield* readTextSafe(fs, path.join(base, name))
        if (text === undefined) continue
        const dest = prefix === "" ? path.join(safeTarget, name) : path.join(safeTarget, prefix, name)
        if (yield* writeTextAtomic(fs, dest, text)) exported++
      }
      if (includeRaw) {
        for (const dir of RAW_DIRS) {
          const entries = yield* fs
            .readDirectoryEntries(path.join(base, dir))
            .pipe(Effect.catch(() => Effect.succeed([])))
          for (const entry of entries) {
            if (entry.type !== "file") continue
            const text = yield* readTextSafe(fs, path.join(base, dir, entry.name))
            if (text === undefined) continue
            const dest =
              prefix === ""
                ? path.join(safeTarget, dir, entry.name)
                : path.join(safeTarget, prefix, dir, entry.name)
            if (yield* writeTextAtomic(fs, dest, text)) exported++
          }
        }
      }
    })
  if (roots.workspaceDir !== undefined) {
    yield* writeScope(roots.workspaceDir, "")
    yield* writeScope(roots.globalDir, "global")
  } else {
    yield* writeScope(roots.globalDir, "")
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
      const srcFile = path.join(safeSource, relative)
      // Refuse pack-internal symlinks (follow-on read would escape pack root).
      if (isSymlinkPath(srcFile)) {
        skipped++
        return
      }
      const text = yield* readTextSafe(fs, srcFile)
      if (text === undefined) return
      if (scanForThreats(text).length > 0) {
        skipped++
        return
      }
      const target = path.join(base, relative)
      const localMtime = yield* mtimeOf(fs, target)
      const srcMtime = yield* mtimeOf(fs, srcFile)
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
