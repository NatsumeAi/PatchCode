import path from "path"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"

export interface MemoryRoots {
  readonly globalDir: string
  readonly workspaceDir: string | undefined
}

export function resolveRoots(globalBase: string, projectDirectory: string | undefined): MemoryRoots {
  return {
    globalDir: globalBase,
    workspaceDir: projectDirectory ? path.join(projectDirectory, ".opencode", "memory") : undefined,
  }
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
 * Writes a file, creating parent directories on demand. Not rename-atomic;
 * the exclusive-create invariant for notes is enforced separately with the
 * "wx" flag in the memory_add_note tool.
 */
export const writeTextAtomic = Effect.fn("Memory.writeTextAtomic")(function* (
  fs: FSUtil.Interface,
  filePath: string,
  content: string,
) {
  yield* fs.ensureDir(path.dirname(filePath))
  yield* fs.writeWithDirs(filePath, content)
})
