import { Effect, Option } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import type { MemoryRoots } from "./storage"
import type { MemoryIndex } from "./reindex"
import { selectPruneCandidates } from "./prune"

export interface MemoryHealth {
  readonly files: number
  readonly totalBytes: number
  readonly chunks: number
  readonly bySource: Record<"global" | "workspace" | "session", number>
  readonly zeroAccessChunks: number
  readonly pruneCandidates: number
  readonly lastConsolidatedAt?: number
}

/** Aggregates memory usage from the filesystem and the derived index. */
export const collectHealth = Effect.fn("Memory.collectHealth")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  index: MemoryIndex,
) {
  const base = roots.workspaceDir ?? roots.globalDir
  let files = 0
  let totalBytes = 0
  const walk = (dir: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.type === "directory") {
          yield* walk(full)
        } else if (entry.type === "file" && entry.name.endsWith(".md")) {
          files++
          const info = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info) totalBytes += Number(info.size)
        }
      }
    })
  yield* walk(base)
  const chunkRows = yield* index.listChunks().pipe(Effect.catch(() => Effect.succeed([])))
  const bySource = { global: 0, workspace: 0, session: 0 }
  let zeroAccessChunks = 0
  for (const row of chunkRows) {
    bySource[row.source as "global" | "workspace" | "session"]++
    if (row.accessCount === 0) zeroAccessChunks++
  }
  const pruneCandidates = selectPruneCandidates(
    chunkRows.map((row) => ({
      chunkId: String(row.id),
      path: row.path,
      excerpt: row.text.slice(0, 120),
      accessCount: row.accessCount,
      mtimeMs: row.mtimeMs,
    })),
    Date.now(),
  ).length
  const last = yield* fs
    .stat(path.join(base, "consolidation.last"))
    .pipe(Effect.catch(() => Effect.succeed(undefined)))
  return {
    files,
    totalBytes,
    chunks: chunkRows.length,
    bySource,
    zeroAccessChunks,
    pruneCandidates,
    ...(last !== undefined ? { lastConsolidatedAt: Option.getOrElse(last.mtime, () => new Date(0)).getTime() } : {}),
  }
})
