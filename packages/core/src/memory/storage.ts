import path from "path"
import { realpathSync, existsSync, lstatSync } from "fs"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"

export interface MemoryRoots {
  readonly globalDir: string
  readonly workspaceDir: string | undefined
}

/**
 * Resolve a memory root path without following a hijacked symlink out of its
 * expected parent. If `dir` itself is a symlink whose target escapes
 * `mustBeUnder`, returns undefined (caller disables that scope).
 * Non-existent paths stay lexical (created later under the intended parent).
 */
export function safeMemoryRoot(dir: string, mustBeUnder?: string): string | undefined {
  const abs = path.resolve(dir)
  if (!existsSync(abs)) {
    if (mustBeUnder !== undefined && !FSUtil.contains(path.resolve(mustBeUnder), abs)) return undefined
    return abs
  }
  try {
    const stat = lstatSync(abs)
    if (stat.isSymbolicLink() && mustBeUnder !== undefined) {
      const real = realpathSync(abs)
      const parentReal = realpathSync(path.resolve(mustBeUnder))
      if (!FSUtil.contains(parentReal, real)) return undefined
      return real
    }
    return realpathSync(abs)
  } catch {
    return abs
  }
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