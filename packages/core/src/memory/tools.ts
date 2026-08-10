export * as MemoryTools from "./tools"

import path from "path"
import { Effect, Layer, Option, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { Tools } from "../tool/tools"
import { ToolRegistry } from "../tool/registry"
import { Tool } from "../tool/tool"
import { resolveRoots, readTextSafe, type MemoryRoots } from "./storage"
import { resolveScoped, resolveScopedFile, NotFileError, MissingError, type ScopedPathError } from "./paths"
import { scanForThreats, BLOCK_PLACEHOLDER } from "./scan"
import { openMemoryIndex, ensureIndexed } from "./reindex"
import { ftsQuery } from "./recall"
import { rankResults, isContentFree, staleNote } from "./ranking"

const MemoryListInput = Schema.Struct({
  path: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.Literals(["workspace", "global", "all"])),
})
const MemoryListOutput = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.Literals(["file", "directory"]),
      scope: Schema.Literals(["workspace", "global"]),
    }),
  ),
})

const MemoryReadInput = Schema.Struct({
  path: Schema.String,
  max_tokens: Schema.optional(Schema.Number),
})
const MemoryReadOutput = Schema.Struct({ content: Schema.String, truncated: Schema.Boolean })

const MemorySearchInput = Schema.Struct({
  query: Schema.String,
  max_results: Schema.optional(Schema.Number),
})
const MemorySearchOutput = Schema.Struct({
  matches: Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.Number, text: Schema.String })),
})

const MemoryAddNoteInput = Schema.Struct({ note: Schema.String })
const MemoryAddNoteOutput = Schema.Struct({ filename: Schema.String })

const MAX_SEARCH_RESULTS = 50
const DEFAULT_SEARCH_RESULTS = 20

function slugFromNote(note: string): string {
  const cleaned = note
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
  return cleaned.length > 0 ? cleaned : "note"
}

function timestampPrefix(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

const scopedFailure = (relative: string) => (error: ScopedPathError) =>
  new Tool.Failure({
    message: error instanceof NotFileError
      ? `Memory path is not a file: ${relative}`
      : error instanceof MissingError
        ? `Memory path not found: ${relative}`
        : `Memory path rejected (${error._tag}): ${relative}`,
  })

type MemoryScope = "workspace" | "global"

/** Root directories selected for list/read by explicit scope (default: all when both exist). */
export function listScopes(roots: MemoryRoots, scope?: "workspace" | "global" | "all"): Array<{ scope: MemoryScope; base: string }> {
  const want = scope ?? (roots.workspaceDir !== undefined ? "all" : "global")
  const out: Array<{ scope: MemoryScope; base: string }> = []
  if ((want === "all" || want === "workspace") && roots.workspaceDir !== undefined) {
    out.push({ scope: "workspace", base: roots.workspaceDir })
  }
  if (want === "all" || want === "global") {
    out.push({ scope: "global", base: roots.globalDir })
  }
  // Workspace-only request with no workspace: fall back to global so tools still work.
  if (out.length === 0) out.push({ scope: "global", base: roots.globalDir })
  return out
}

/**
 * Writes an exclusive append-only note under `extensions/ad_hoc/notes/`.
 * On second-level wx collision, retries with a random suffix so concurrent
 * same-second writes do not fail the user-facing tool.
 */
export const writeMemoryNote = Effect.fn("Memory.writeMemoryNote")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  note: string,
) {
  const base = roots.workspaceDir ?? roots.globalDir
  const notesDir = path.join(base, "extensions", "ad_hoc", "notes")
  yield* fs.ensureDir(notesDir)
  const slug = slugFromNote(note)
  const primary = `${timestampPrefix()}-${slug}.md`
  const tryWrite = (filename: string) =>
    fs.writeFileString(path.join(notesDir, filename), note, { flag: "wx" }).pipe(Effect.as(filename))
  return yield* tryWrite(primary).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "AlreadyExists",
      () => tryWrite(`${timestampPrefix()}-${slug}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.md`),
    ),
    Effect.map((filename) => ({ filename })),
  )
})

export const registerMemoryTools = Effect.fn("Memory.registerMemoryTools")(function* () {
  const tools = yield* Tools.Service
  const fs = yield* FSUtil.Service
  const location = yield* Location.Service
  const global = yield* Global.Service
  const rootsOf = () => resolveRoots(path.join(global.data, "memory"), location.directory)

  yield* tools.register({
    memory_list: Tool.make({
      description:
        "List files and directories in the memory folder (root by default). Optional scope: workspace | global | all (default all when both roots exist). Each entry includes scope. Use memory_read/memory_search to inspect content.",
      input: MemoryListInput,
      output: MemoryListOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
      execute: (input) =>
        Effect.gen(function* () {
          const roots = rootsOf()
          const relative = input.path ?? ""
          const scopes = listScopes(roots, input.scope)
          const entries: Array<{ name: string; type: "file" | "directory"; scope: MemoryScope }> = []
          for (const item of scopes) {
            const target = yield* resolveScoped(fs, item.base, relative).pipe(
              Effect.catch((error: ScopedPathError) => {
                if (error instanceof MissingError) return Effect.succeed(undefined as string | undefined)
                return Effect.fail(scopedFailure(relative)(error))
              }),
            )
            if (target === undefined) continue
            const listed = yield* fs.readDirectoryEntries(target).pipe(Effect.catch(() => Effect.succeed([])))
            for (const entry of listed) {
              if (entry.type !== "file" && entry.type !== "directory") continue
              entries.push({
                name: entry.name,
                type: entry.type === "directory" ? "directory" : "file",
                scope: item.scope,
              })
            }
          }
          if (entries.length === 0 && relative !== "") {
            return yield* new Tool.Failure({ message: `Memory path not found: ${relative}` })
          }
          return { entries }
        }),
    }),
    memory_read: Tool.make({
      description:
        "Read a memory file by relative path (tries workspace then global when both roots exist). max_tokens optional, default 1000 tokens; content truncated when larger.",
      input: MemoryReadInput,
      output: MemoryReadOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: output.content }],
      execute: (input) =>
        Effect.gen(function* () {
          const roots = rootsOf()
          // Prefer workspace, then global — dual-root read consistency.
          const order = listScopes(roots, "all")
          let file: string | undefined
          let base: string | undefined
          for (const item of order) {
            const resolved = yield* resolveScopedFile(fs, item.base, input.path).pipe(
              Effect.catch(() => Effect.succeed(undefined as string | undefined)),
            )
            if (resolved !== undefined) {
              file = resolved
              base = item.base
              break
            }
          }
          if (file === undefined || base === undefined) {
            return yield* Effect.fail(scopedFailure(input.path)(new MissingError({ relative: input.path })))
          }
          const text = yield* Effect.orElseSucceed(readTextSafe(fs, file), () => undefined)
          const relative = path.relative(base, file).replace(/\\/g, "/")
          const index = yield* openMemoryIndex(fs, roots).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (index !== undefined) {
            try {
              const hits = yield* index.chunkIdsForPath(relative).pipe(Effect.catch(() => Effect.succeed([])))
              yield* index.incrementAccess(hits).pipe(Effect.catch(() => Effect.void))
            } finally {
              yield* index.close().pipe(Effect.catch(() => Effect.void))
            }
          }
          const max = Math.max(1, input.max_tokens ?? 1000) * 4
          const raw = (text ?? "").slice(0, max)
          const threatIds = scanForThreats(raw)
          const content = threatIds.length > 0 ? BLOCK_PLACEHOLDER(threatIds) : raw
          return { content, truncated: (text?.length ?? 0) > max }
        }),
    }),
    memory_search: Tool.make({
      description:
        "Search memory files (workspace + global indexes) for a query. Returns ranked matching chunks with relative path and line numbers (max_results optional, default 20, max 50). Scaffold content is omitted.",
      input: MemorySearchInput,
      output: MemorySearchOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output.matches) }],
      execute: (input) =>
        Effect.gen(function* () {
          const roots = rootsOf()
          const max = Math.min(input.max_results ?? DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS)
          const index = yield* openMemoryIndex(fs, roots).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (index !== undefined) {
            try {
              yield* ensureIndexed(index, fs, roots).pipe(Effect.catch(() => Effect.void))
              const hits = yield* index.search(ftsQuery(input.query), max * 4).pipe(Effect.catch(() => Effect.succeed([])))
              const ranked = rankResults(
                hits
                  .filter((hit) => !isContentFree(hit.text))
                  .filter((hit) => scanForThreats(hit.text).length === 0)
                  .map((hit) => ({ ...hit, source: hit.source })),
              ).slice(0, max)
              yield* index
                .incrementAccess(ranked.map((hit) => ({ id: hit.id, source: hit.source })))
                .pipe(Effect.catch(() => Effect.void))
              return {
                matches: ranked.map((hit) => {
                  const threatIds = scanForThreats(hit.text)
                  const text = threatIds.length > 0 ? BLOCK_PLACEHOLDER(threatIds) : hit.text
                  return { path: hit.path, line: hit.line, text: `${text} ${staleNote(hit.ageDays, hit.source)}`.trim() }
                }),
              }
            } finally {
              yield* index.close().pipe(Effect.catch(() => Effect.void))
            }
          }
          // Fallback walk both roots when the index is unavailable.
          const query = input.query.toLowerCase()
          const matches: Array<{ path: string; line: number; text: string }> = []
          const walk = (dir: string, rootBase: string, source: MemoryScope): Effect.Effect<void> =>
            Effect.gen(function* () {
              const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
              for (const entry of entries) {
                if (matches.length >= max) return
                if (entry.type === "directory") {
                  if (entry.name.startsWith(".")) continue
                  yield* walk(path.join(dir, entry.name), rootBase, source)
                  continue
                }
                if (entry.type !== "file" || !entry.name.endsWith(".md")) continue
                const filePath = path.join(dir, entry.name)
                const info = yield* fs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!info || info.size > 1024 * 1024) continue
                const mtime = Option.getOrElse(info.mtime, () => new Date(0)).getTime()
                const text = yield* readTextSafe(fs, filePath).pipe(Effect.catch(() => Effect.succeed("")))
                if (!text || isContentFree(text)) continue
                for (const [lineIndex, line] of text.split("\n").entries()) {
                  if (matches.length >= max) break
                  if (line.toLowerCase().includes(query)) {
                    const threatIds = scanForThreats(line)
                    const clean = threatIds.length > 0 ? BLOCK_PLACEHOLDER(threatIds) : line
                    const relative = path.relative(rootBase, filePath).replace(/\\/g, "/")
                    const ageDays = (Date.now() - mtime) / (24 * 60 * 60 * 1000)
                    const note = staleNote(ageDays, relative.startsWith("sessions/") ? "session" : source)
                    matches.push({ path: relative, line: lineIndex + 1, text: `${clean} ${note}`.trim() })
                  }
                }
              }
            })
          for (const item of listScopes(roots, "all")) {
            yield* walk(item.base, item.base, item.scope)
          }
          return { matches }
        }),
    }),
    memory_add_note: Tool.make({
      description:
        "Create one append-only memory note ONLY after the user explicitly asks to remember, forget, or update something. Do NOT write notes unprompted.",
      input: MemoryAddNoteInput,
      output: MemoryAddNoteOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: `Memory note saved: ${output.filename}` }],
      execute: (input) =>
        Effect.gen(function* () {
          const note = input.note.trim()
          if (note.length === 0) return yield* new Tool.Failure({ message: "Note cannot be empty." })
          const threatIds = scanForThreats(note)
          if (threatIds.length > 0) {
            return yield* new Tool.Failure({ message: `Note rejected: threat pattern(s) ${threatIds.join(", ")}` })
          }
          return yield* writeMemoryNote(fs, rootsOf(), note).pipe(
            Effect.mapError((error) =>
              error && typeof error === "object" && "reason" in error && (error as { reason: { _tag: string } }).reason._tag === "AlreadyExists"
                ? new Tool.Failure({ message: "Note file already exists; retry." })
                : new Tool.Failure({ message: `Note write failed: ${String(error)}` }),
            ),
          )
        }),
    }),
  }).pipe(Effect.orDie)
})

export const node = makeLocationNode({
  name: "memory-tools",
  layer: Layer.effectDiscard(Effect.suspend(() => registerMemoryTools())),
  deps: [ToolRegistry.node, FSUtil.node, Location.node, Global.node],
})
