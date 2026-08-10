import path from "path"
import { realpathSync, existsSync } from "fs"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"

export interface MemoryRoots {
  readonly globalDir: string
  readonly workspaceDir: string | undefined
}

/**
 * Resolve a memory root path without following a hijacked symlink out of its
 * expected parent. Checks the final component *and* intermediate parents
 * (e.g. `.opencode` → attacker/ with `memory/` under it). Escapes return
 * undefined so the caller disables that scope.
 *
 * Non-existent paths: realpath the deepest existing ancestor, reconstruct the
 * candidate, then require it still sits under `mustBeUnder`.
 */
export function safeMemoryRoot(dir: string, mustBeUnder?: string): string | undefined {
  const abs = path.resolve(dir)
  if (mustBeUnder === undefined) {
    if (!existsSync(abs)) return abs
    try {
      return realpathSync(abs)
    } catch {
      return abs
    }
  }

  const parentAbs = path.resolve(mustBeUnder)
  // Deepest existing ancestor (handles missing leaf or intermediate).
  let probe = abs
  while (!existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }

  let realProbe: string
  try {
    realProbe = existsSync(probe) ? realpathSync(probe) : probe
  } catch {
    realProbe = probe
  }

  const rel = path.relative(probe, abs)
  const candidate =
    rel === "" || rel === "." ? realProbe : path.resolve(realProbe, rel)

  let parentReal: string
  try {
    parentReal = existsSync(parentAbs) ? realpathSync(parentAbs) : parentAbs
  } catch {
    parentReal = parentAbs
  }

  if (!FSUtil.contains(parentReal, candidate)) return undefined
  return candidate
}

export function resolveRoots(globalBase: string, projectDirectory: string | undefined): MemoryRoots {
  const globalDir = safeMemoryRoot(globalBase) ?? path.resolve(globalBase)
  const workspaceDir =
    projectDirectory !== undefined
      ? safeMemoryRoot(path.join(projectDirectory, ".opencode", "memory"), projectDirectory)
      : undefined
  return { globalDir, workspaceDir }
}

export function memoryDir(root: MemoryRoots, relative: string): string {
  const target = path.resolve(root.globalDir, relative)
  if (!FSUtil.contains(root.globalDir, target)) {
    throw new Error(`Memory path escapes the memory root: ${relative}`)
  }
  return target
}

/** Reads a file, returning `undefined` on missing/denied instead of failing. */
export const readTextSafe = Effect.fn("Memory.readTextSafe")(function* (fs: FSUtil.Interface, filePath: string) {
  return yield* fs.readFileStringSafe(filePath)
})

/**
 * Writes a file via temp-file + rename so a crash never leaves a half-written
 * archive (MEMORY.md, memory_summary.md, session logs). The exclusive-create
 * invariant for notes is enforced separately with the "wx" flag.
 *
 * Returns `true` when the rename (and therefore the write) succeeded, `false`
 * when the temp file was written but the atomic rename failed — callers that
 * delete source data only after a confirmed write must gate on this result.
 * On rename failure the temp file is best-effort removed so retries do not
 * accumulate stale `.tmp` files.
 */
export const writeTextAtomic = Effect.fn("Memory.writeTextAtomic")(function* (
  fs: FSUtil.Interface,
  filePath: string,
  content: string,
) {
  yield* fs.ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.tmp`
  yield* fs.writeWithDirs(tmp, content)
  return yield* fs.rename(tmp, filePath).pipe(
    Effect.tapError((error) => Effect.logWarning(`memory atomic rename failed for ${filePath}: ${String(error)}`)),
    Effect.matchEffect({
      onSuccess: () => Effect.succeed(true as const),
      onFailure: () =>
        fs.remove(tmp).pipe(
          Effect.catch(() => Effect.void),
          Effect.as(false as const),
        ),
    }),
  )
})