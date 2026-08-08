export * as MemoryReindex from "./reindex"

import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { sql } from "drizzle-orm"
import { Effect, Option } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import type { MemoryRoots } from "./storage"
import { cosineSimilarity, normalize01, hybridScore, DEFAULT_MIN_SCORE } from "./hybrid"

type SyncDB = ReturnType<typeof drizzle>
type Row = Record<string, unknown>

export interface ChunkHit {
  readonly id: number
  readonly path: string
  readonly line: number
  readonly text: string
  readonly score: number
  readonly source: "global" | "workspace" | "session"
  readonly ageDays: number
}

export interface IndexChunk {
  readonly id: number
  readonly path: string
  readonly source: string
  readonly accessCount: number
  readonly mtimeMs: number
  readonly text: string
  readonly startLine?: number
  readonly vectors?: ReadonlyArray<number>
}

export interface MemoryIndex {
  readonly insert: (
    root: "global" | "workspace",
    input: {
      path: string
      source: string
      text: string
      startLine: number
      endLine: number
      mtimeMs: number
      vectors?: ReadonlyArray<number>
    },
  ) => Effect.Effect<void, IndexError>
  readonly deletePath: (root: "global" | "workspace", filePath: string) => Effect.Effect<void, IndexError>
  readonly search: (query: string, limit: number) => Effect.Effect<Array<ChunkHit>, IndexError>
  readonly incrementAccess: (
    hits: ReadonlyArray<{ id: number; source: "global" | "workspace" | "session" }>,
  ) => Effect.Effect<void, IndexError>
  readonly chunkIdsForPath: (
    filePath: string,
  ) => Effect.Effect<Array<{ id: number; source: "global" | "workspace" }>, IndexError>
  readonly chunkHashesForPath: (root: "global" | "workspace", filePath: string) => Effect.Effect<Array<[string, number]>, IndexError>
  readonly removeChunks: (root: "global" | "workspace", ids: ReadonlyArray<number>) => Effect.Effect<void, IndexError>
  readonly listChunks: () => Effect.Effect<Array<IndexChunk>, IndexError>
  readonly close: () => Effect.Effect<void>
  readonly provider?: import("./embedding").EmbeddingProvider
}

const CREATE_CHUNKS = `CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  vectors TEXT
)`
const CREATE_PATH_INDEX = `CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path)`
const CREATE_HASH_PATH_UNIQUE = `CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_hash_path ON chunks(hash, path)`
const CREATE_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text)`

/** Stable content hash for dedup (sha256 hex; Bun.hash is not stable across versions). */
export const chunkHash = (text: string): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(text)
  return hasher.digest("hex")
}

/**
 * Markdown-aware chunking: split on `##` sections, then paragraphs, then lines.
 * Continuation chunks keep their section's header so context survives splitting.
 */
export function chunkMarkdown(content: string, maxChars: number): Array<{ text: string; startLine: number; endLine: number }> {
  if (content.length <= maxChars) return [{ text: content, startLine: 1, endLine: content.split("\n").length }]
  const chunks: Array<{ text: string; startLine: number; endLine: number }> = []
  const sections = content.split(/(?=^## )/m)
  let line = 1
  for (const section of sections) {
    const sectionLines = section.split("\n").length
    if (section.length <= maxChars) {
      chunks.push({ text: section.trim(), startLine: line, endLine: line + sectionLines - 1 })
      line += sectionLines
      continue
    }
    const header = section.split("\n")[0] ?? ""
    const paragraphs = section.split(/\n\n+/)
    let acc = ""
    let accStart = line
    for (const para of paragraphs) {
      const paraLines = para.split("\n").length
      if (acc !== "" && (acc + "\n\n" + para).length > maxChars) {
        chunks.push({ text: acc.trim(), startLine: accStart, endLine: Math.max(accStart, line - 1) })
        acc = `${header}\n\n${para}`
        accStart = line
      } else {
        acc = acc === "" ? para : acc + "\n\n" + para
      }
      line += paraLines + 1
    }
    if (acc !== "") chunks.push({ text: acc.trim(), startLine: accStart, endLine: line - 1 })
  }
  return chunks
}

const openOne = (file: string) =>
  q(() => {
    const native = new Database(file, { create: true })
    // busy_timeout must precede journal_mode=WAL: the WAL PRAGMA is a write that
    // would otherwise run with the default 0ms busy timeout and fail under
    // concurrent access.
    native.run("PRAGMA busy_timeout = 5000")
    native.run("PRAGMA journal_mode = WAL")
    native.run(CREATE_CHUNKS)
    native.run(CREATE_PATH_INDEX)
    native.run(CREATE_HASH_PATH_UNIQUE)
    native.run(CREATE_FTS)
    return { native, db: drizzle({ client: native }) }
  })

const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : [value as Row])

/** Safe multi-element IN clause (plain array binding renders as IN ((?, ?)) — broken). */
const inClause = (ids: ReadonlyArray<number>) => sql.join(ids.map((id) => sql`${id}`), sql`, `)

export class IndexError {
  constructor(readonly message: string) {}
}

const q = <A>(fn: () => A): Effect.Effect<A, IndexError> => Effect.try({ try: fn, catch: (cause) => new IndexError(String(cause)) })

/** Opens per-root index databases (dual-root: global always, workspace when present). */
export const openMemoryIndex = Effect.fn("Memory.openMemoryIndex")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  provider?: import("./embedding").EmbeddingProvider,
) {
  yield* fs.ensureDir(roots.globalDir)
  if (roots.workspaceDir !== undefined) yield* fs.ensureDir(roots.workspaceDir)
  const global = yield* openOne(path.join(roots.globalDir, "index.sqlite")).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (global === undefined) return yield* Effect.fail(new IndexError("cannot open memory index"))
  const workspace =
    roots.workspaceDir === undefined
      ? undefined
      : yield* openOne(path.join(roots.workspaceDir, "index.sqlite")).pipe(Effect.catch(() => Effect.succeed(undefined)))

  const sourceOf = (root: "global" | "workspace", pathInRoot: string): "global" | "workspace" | "session" => {
    if (pathInRoot.startsWith("sessions/")) return "session"
    return root
  }

  const withBoth = (
    onGlobal: (db: SyncDB) => Effect.Effect<unknown, IndexError>,
    onWorkspace: (db: SyncDB) => Effect.Effect<unknown, IndexError>,
  ): Effect.Effect<void, IndexError> =>
    Effect.gen(function* () {
      yield* onGlobal(global.db)
      if (workspace !== undefined) yield* onWorkspace(workspace.db)
    })

  const pick = (root: "global" | "workspace") => {
    if (root === "workspace" && workspace !== undefined) return workspace.db
    return global.db
  }
  return {
    insert: Effect.fn("MemoryIndex.insert")(function* (root, input) {
      const db = pick(root)
      const vectorsJson = input.vectors === undefined ? null : JSON.stringify(input.vectors)
      const id = yield* q(() => db.all(sql`INSERT INTO chunks (hash, path, start_line, end_line, text, source, mtime_ms, vectors)
        VALUES (${chunkHash(input.text)}, ${input.path}, ${input.startLine}, ${input.endLine}, ${input.text}, ${input.source}, ${input.mtimeMs}, ${vectorsJson})
        ON CONFLICT(hash, path) DO NOTHING RETURNING id`)).pipe(
        Effect.map((result) => rowsOf(result)[0]?.id),
      )
      if (id === undefined) return
      yield* q(() => db.run(sql`INSERT INTO chunks_fts (rowid, text) VALUES (${Number(id)}, ${input.text})`)).pipe(
        Effect.asVoid,
      )
    }),
    deletePath: Effect.fn("MemoryIndex.deletePath")(function* (root, filePath) {
      const db = pick(root)
      const ids = yield* q(() => db.all(sql`SELECT id FROM chunks WHERE path = ${filePath}`)).pipe(
        Effect.map((result) => rowsOf(result).map((row) => Number(row.id))),
      )
      if (ids.length === 0) return
      yield* q(() => db.run(sql`DELETE FROM chunks_fts WHERE rowid IN (${ids})`)).pipe(
        Effect.flatMap(() => q(() => db.run(sql`DELETE FROM chunks WHERE id IN (${ids})`))),
        Effect.asVoid,
      )
    }),
    search: Effect.fn("MemoryIndex.search")(function* (query: string, limit: number) {
      const hits: ChunkHit[] = []
      const searchOne = (db: SyncDB, root: "global" | "workspace"): Effect.Effect<void, IndexError> =>
        q(() =>
          db.all(
            sql`SELECT c.id, c.path, c.start_line, c.text, c.source, c.mtime_ms, -bm25(chunks_fts) AS score
              FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
              WHERE chunks_fts MATCH ${query}
              ORDER BY score DESC LIMIT ${limit}`,
          ),
        ).pipe(
          Effect.flatMap((result) => {
              for (const row of rowsOf(result)) {
                hits.push({
                  id: Number(row.id),
                  path: String(row.path),
                  line: Number(row.start_line),
                  text: String(row.text),
                  score: Number(row.score),
                  source: sourceOf(root, String(row.path)),
                  ageDays: (Date.now() - Number(row.mtime_ms)) / (24 * 60 * 60 * 1000),
                })
              }
              return Effect.void
            }),
          )
      yield* searchOne(global.db, "global")
      if (workspace !== undefined) yield* searchOne(workspace.db, "workspace")
      if (provider === undefined) return hits
      // Hybrid path: cosine over stored vectors + BM25, weighted, min_score.
      const queryVector = yield* provider.embedBatch([query]).pipe(Effect.catch(() => Effect.succeed([])))
      const qv = queryVector[0]
      if (qv === undefined || qv.length === 0) return hits
      const collectChunks = (db: SyncDB): Effect.Effect<Array<IndexChunk>, IndexError> =>
        q(() => db.all(sql`SELECT id, path, start_line, source, text, vectors FROM chunks`)).pipe(
          Effect.map((result) =>
            rowsOf(result).map((row) => {
              const vectors = row.vectors
              return {
                id: Number(row.id),
                path: String(row.path),
                source: String(row.source),
                accessCount: 0,
                mtimeMs: 0,
                text: String(row.text),
                startLine: Number(row.start_line),
                vectors: typeof vectors === "string" ? (JSON.parse(vectors) as Array<number>) : undefined,
              }
            }),
          ),
        )
      const [globalChunks, workspaceChunks] = yield* Effect.all([
        collectChunks(global.db),
        workspace === undefined ? Effect.succeed([]) : collectChunks(workspace.db),
      ])
      const chunks = [...globalChunks, ...workspaceChunks]
      const vectorScored = chunks
        .map((chunk) => ({ chunk, cosine: cosineSimilarity(qv, chunk.vectors ?? []) }))
        .sort((a, b) => b.cosine - a.cosine)
        .slice(0, limit * 4)
      const ftsById = new Map(hits.map((hit) => [hit.id, hit]))
      const candidates: Array<{
        hit: ChunkHit | undefined
        chunk: IndexChunk
        cosine: number
        textScore: number
      }> = []
      for (const item of vectorScored) {
        candidates.push({
          hit: ftsById.get(item.chunk.id),
          chunk: item.chunk,
          cosine: item.cosine,
          textScore: ftsById.get(item.chunk.id)?.score ?? 0,
        })
      }
      for (const hit of hits) {
        if (!vectorScored.some((item) => item.chunk.id === hit.id)) {
          candidates.push({
            hit,
            chunk: { id: hit.id, path: hit.path, source: hit.source, accessCount: 0, mtimeMs: 0, text: hit.text },
            cosine: 0,
            textScore: hit.score,
          })
        }
      }
      const textNorm = normalize01(candidates.map((candidate) => candidate.textScore))
      const vecNorm = normalize01(candidates.map((candidate) => candidate.cosine))
      const scored: ChunkHit[] = candidates
        .map((candidate, index) => ({
          id: candidate.chunk.id,
          path: candidate.chunk.path,
          line: candidate.hit?.line ?? candidate.chunk.startLine ?? 1,
          text: candidate.chunk.text,
          score: hybridScore(vecNorm[index]!, textNorm[index]!),
          source: candidate.hit?.source ?? (candidate.chunk.source as ChunkHit["source"]),
          ageDays: candidate.hit?.ageDays ?? 0,
        }))
        .filter((item) => item.score >= DEFAULT_MIN_SCORE)
        .sort((a, b) => b.score - a.score)
      return scored.slice(0, limit)
    }),
    incrementAccess: Effect.fn("MemoryIndex.incrementAccess")(function* (
      hits: ReadonlyArray<{ id: number; source: "global" | "workspace" | "session" }>,
    ) {
      if (hits.length === 0) return
      const globalIds = hits
        .filter((hit) => hit.source === "global" || (hit.source === "session" && workspace === undefined))
        .map((hit) => hit.id)
      const workspaceIds = hits
        .filter((hit) => hit.source === "workspace" || (hit.source === "session" && workspace !== undefined))
        .map((hit) => hit.id)
      if (globalIds.length > 0) {
        yield* q(() =>
          global.db.run(sql`UPDATE chunks SET access_count = access_count + 1 WHERE id IN (${inClause(globalIds)})`),
        ).pipe(Effect.asVoid)
      }
      if (workspace !== undefined && workspaceIds.length > 0) {
        yield* q(() =>
          workspace.db.run(sql`UPDATE chunks SET access_count = access_count + 1 WHERE id IN (${inClause(workspaceIds)})`),
        ).pipe(Effect.asVoid)
      }
    }),
    chunkHashesForPath: Effect.fn("MemoryIndex.chunkHashesForPath")(function* (root, filePath) {
      const db = pick(root)
      return yield* q(() => db.all(sql`SELECT id, hash FROM chunks WHERE path = ${filePath}`)).pipe(
        Effect.map((result) => rowsOf(result).map((row) => [String(row.hash), Number(row.id)] as [string, number])),
      )
    }),
    removeChunks: Effect.fn("MemoryIndex.removeChunks")(function* (root, ids) {
      if (ids.length === 0) return
      const db = pick(root)
      yield* q(() => db.run(sql`DELETE FROM chunks_fts WHERE rowid IN (${inClause(ids)})`)).pipe(
        Effect.flatMap(() => q(() => db.run(sql`DELETE FROM chunks WHERE id IN (${inClause(ids)})`))),
        Effect.asVoid,
      )
    }),
    chunkIdsForPath: Effect.fn("MemoryIndex.chunkIdsForPath")(function* (filePath) {
      const collect = (db: SyncDB, source: "global" | "workspace") =>
        q(() => db.all(sql`SELECT id FROM chunks WHERE path = ${filePath}`)).pipe(
          Effect.map((result) => rowsOf(result).map((row) => ({ id: Number(row.id), source }))),
        )
      const [globalIds, workspaceIds] = yield* Effect.all([
        collect(global.db, "global"),
        workspace === undefined ? Effect.succeed([]) : collect(workspace.db, "workspace"),
      ])
      return [...globalIds, ...workspaceIds]
    }),
    listChunks: Effect.fn("MemoryIndex.listChunks")(function* () {
      const collect = (db: SyncDB): Effect.Effect<Array<IndexChunk>, IndexError> =>
        q(() => db.all(sql`SELECT id, path, source, access_count, mtime_ms, text FROM chunks`)).pipe(
          Effect.map((result) =>
              rowsOf(result).map((row) => ({
                id: Number(row.id),
                path: String(row.path),
                source: String(row.source),
                accessCount: Number(row.access_count),
                mtimeMs: Number(row.mtime_ms),
                text: String(row.text),
              })),
            ),
          )
      const [globalChunks, workspaceChunks] = yield* Effect.all([
        collect(global.db),
        workspace === undefined ? Effect.succeed([]) : collect(workspace.db),
      ])
      return [...globalChunks, ...workspaceChunks]
    }),
    close: Effect.fn("MemoryIndex.close")(function* () {
      yield* Effect.sync(() => {
        global.native.close()
        workspace?.native.close()
      })
    }),
    provider,
  }
})

/** Chunks a file and indexes it with hash dedup; stale chunks for the path are removed. */
export const reindexFile = Effect.fn("Memory.reindexFile")(function* (
  index: MemoryIndex,
  root: "global" | "workspace",
  filePath: string,
  source: "global" | "workspace" | "session",
  text: string,
  mtimeMs: number,
) {
  const relative = filePath.replace(/\\/g, "/")
  const chunks = chunkMarkdown(text, 1500)
  const newHashes = new Set(chunks.map((chunk) => chunkHash(chunk.text)))
  // Remove only chunks whose content is gone (hash changed); unchanged chunks
  // keep their rows, ids, and access_count across reindexes and restarts.
  const stale = yield* index.chunkHashesForPath(root, relative).pipe(Effect.catch(() => Effect.succeed([])))
  const staleIds = stale.filter(([hash]) => !newHashes.has(hash)).map(([, id]) => id)
  yield* index.removeChunks(root, staleIds).pipe(Effect.catch(() => Effect.void))
  let vectors: ReadonlyArray<ReadonlyArray<number>> = []
  if (index.provider !== undefined) {
    vectors = yield* index.provider
      .embedBatch(chunks.map((chunk) => chunk.text))
      .pipe(Effect.catch(() => Effect.succeed([])))
  }
  for (const [index_, chunk] of chunks.entries()) {
    yield* index.insert(root, {
      path: relative,
      source,
      text: chunk.text,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      mtimeMs,
      vectors: vectors[index_],
    })
  }
})

// Process-lifetime cache of the last indexed mtime per file path, so unchanged
// files are skipped and access_count is never reset by reindexing.
const indexedMtimes = new Map<string, number>()

/** Walks the memory roots and (re)indexes changed .md files (lazy, before search). */
export const ensureIndexed = Effect.fn("Memory.ensureIndexed")(function* (
  index: MemoryIndex,
  fs: FSUtil.Interface,
  roots: MemoryRoots,
) {
  const walk = (dir: string, rootDir: string, root: "global" | "workspace", source: "global" | "workspace"): Effect.Effect<void, IndexError> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.type === "directory") {
          if (entry.name.startsWith(".")) continue
          yield* walk(full, rootDir, root, source)
          continue
        }
        if (entry.type !== "file" || !entry.name.endsWith(".md")) continue
        const info = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!info) continue
        const mtime = Option.getOrElse(info.mtime, () => new Date(0)).getTime()
        if (indexedMtimes.get(full) === mtime) continue
        const text = yield* fs.readFileStringSafe(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (text === undefined) continue
        const relative = path.relative(rootDir, full).replace(/\\/g, "/")
        yield* reindexFile(index, root, relative, relative.startsWith("sessions/") ? "session" : source, text, mtime)
        indexedMtimes.set(full, mtime)
      }
    })
  const seen = new Set<string>()
  const mark = (dir: string, rootDir: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.type === "directory") {
          yield* mark(full, rootDir)
        } else if (entry.type === "file" && entry.name.endsWith(".md")) {
          seen.add(path.relative(rootDir, full).replace(/\\/g, "/"))
        }
      }
    })
  yield* walk(roots.globalDir, roots.globalDir, "global", "global")
  if (roots.workspaceDir !== undefined) yield* walk(roots.workspaceDir, roots.workspaceDir, "workspace", "workspace")
  yield* mark(roots.globalDir, roots.globalDir)
  if (roots.workspaceDir !== undefined) yield* mark(roots.workspaceDir, roots.workspaceDir)
  // Drop orphan chunks whose files were deleted since the last index pass.
  const indexed = yield* index.listChunks().pipe(Effect.catch(() => Effect.succeed([])))
  for (const chunk of indexed) {
    if (!seen.has(chunk.path)) {
      // Session chunks live in the workspace index when a workspace exists
      // (per-session capture), otherwise in global — mirror incrementAccess.
      const root = chunk.source === "workspace" || (chunk.source === "session" && roots.workspaceDir !== undefined) ? "workspace" : "global"
      yield* index.deletePath(root, chunk.path).pipe(
        Effect.catch(() => Effect.void),
      )
    }
  }
})
