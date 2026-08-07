import path from "path"
import { Effect, Schema } from "effect"
import { FSUtil } from "../fs-util"

export class EscapeError extends Schema.TaggedErrorClass<EscapeError>()("MemoryEscapeError", {
  relative: Schema.String,
}) {}
export class HiddenError extends Schema.TaggedErrorClass<HiddenError>()("MemoryHiddenError", {
  relative: Schema.String,
}) {}
export class SymlinkError extends Schema.TaggedErrorClass<SymlinkError>()("MemorySymlinkError", {
  relative: Schema.String,
}) {}
export class MissingError extends Schema.TaggedErrorClass<MissingError>()("MemoryMissingError", {
  relative: Schema.String,
}) {}
export class NotFileError extends Schema.TaggedErrorClass<NotFileError>()("MemoryNotFileError", {
  relative: Schema.String,
}) {}

export type ScopedPathError = EscapeError | HiddenError | SymlinkError | MissingError | NotFileError

function isHidden(component: string) {
  return component.startsWith(".")
}

/**
 * Resolves `relative` inside `root`, rejecting traversal, absolute paths,
 * hidden components, and symlinked components (Codex-style triple guard).
 * An empty `relative` resolves to the root itself.
 */
export const resolveScoped = Effect.fn("Memory.resolveScoped")(function* (
  fs: FSUtil.Interface,
  root: string,
  relative: string,
) {
  if (relative === "" || relative === ".") return root
  if (path.isAbsolute(relative)) {
    return yield* new EscapeError({ relative })
  }
  const normalized = relative.split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".")
  if (normalized.includes("..")) {
    return yield* new EscapeError({ relative })
  }
  if (normalized.some(isHidden)) {
    return yield* new HiddenError({ relative })
  }

  let current = root
  for (const component of normalized) {
    const next = path.join(current, component)
    const entries = yield* fs.readDirectoryEntries(current).pipe(Effect.catch(() => Effect.succeed([])))
    const entry = entries.find((item) => item.name === component)
    if (!entry) {
      return yield* new MissingError({ relative })
    }
    if (entry.type === "symlink") {
      return yield* new SymlinkError({ relative })
    }
    current = next
  }
  return current
})

/** Same as `resolveScoped`, but requires the final path to be a regular file. */
export const resolveScopedFile = Effect.fn("Memory.resolveScopedFile")(function* (
  fs: FSUtil.Interface,
  root: string,
  relative: string,
) {
  const resolved = yield* resolveScoped(fs, root, relative)
  const isFile = yield* fs.isFile(resolved).pipe(Effect.catch(() => Effect.succeed(false)))
  if (!isFile) return yield* new NotFileError({ relative })
  return resolved
})
