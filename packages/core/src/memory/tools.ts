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
import { scanForThreats, BLOCK_PLACEHOLDER, MAX_SCAN_CHARS } from "./scan"
import { openConfiguredMemoryIndex, ensureIndexed } from "./reindex"
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
/** Hard cap for a single note write (tool + HTTP remember). */
export const MAX_NOTE_CHARS = 32_768
/** Grep fallback reads at most this many bytes per file (FTS path has no size skip). */
export const GREP_FALLBACK_MAX_CHARS = 1024 * 1024

/** Implementation / binary artifacts that must never be listed or model-read. */
const INTERNAL_MEMORY_NAMES = new Set([
  "index.sqlite",
  "index.sqlite-wal",
  "index.sqlite-shm",
  "merged.hashes",
  "consolidation.lock",
  "consolidation.last",
  "consolidation.status.json",
  ".append.lock",
])

function isListableMemoryEntry(entry: { name: string; type: string }): boolean {
  if (entry.name.startsWith(".")) return false
  if (INTERNAL_MEMORY_NAMES.has(entry.name)) return false
  if (entry.type === "file" && !entry.name.endsWith(".md")) return false
  return true
}

function isReadableMemoryPath(relative: string): boolean {
  const base = path.basename(relative)
  if (base.startsWith(".") || INTERNAL_MEMORY_NAMES.has(base)) return false
  if (!relative.endsWith(".md")) return false
  return true
}

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
  // Callers must enforce MAX_NOTE_CHARS; keep this path write-only.
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
        "List files and directories in the memory folder (root by default). Optional scope: workspace | global | all (default all when both roots exist). Each entry includes scope. Use memory_read/memory_search to inspect content. When citing memory in answers, include path (and line when known).",
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
              if (!isListableMemoryEntry(entry)) continue
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
        "Read a memory file by relative path (tries workspace then global when both roots exist). max_tokens optional, default 1000 tokens; content truncated when larger. When answering from this file, cite the relative path (and line if known). Threat-scanned content may be replaced with a BLOCKED placeholder.",
      input: MemoryReadInput,
      output: MemoryReadOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: output.content }],
      execute: (input) =>
        Effect.gen(function* () {
          const roots = rootsOf()
          if (!isReadableMemoryPath(input.path)) {
            return yield* new Tool.Failure({
              message: `Memory path not readable (markdown files only): ${input.path}`,
            })
          }
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
          const index = yield* openConfiguredMemoryIndex(fs, roots).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (index !== undefined) {
            try {
              const hits = yield* index.chunkIdsForPath(relative).pipe(Effect.catch(() => Effect.succeed([])))
              yield* index.incrementAccess(hits).pipe(Effect.catch(() => Effect.void))
            } finally {
              yield* index.close().pipe(Effect.catch(() => Effect.void))
            }
          }
          const max = Math.max(1, input.max_tokens ?? 1000) * 4
          const full = text ?? ""
          // Never return bytes that were not threat-scanned. Cap scan at MAX_SCAN_CHARS;
          // also cap the returned slice to the scanned prefix.
          const scannable = full.slice(0, MAX_SCAN_CHARS)
          const threatIds = scanForThreats(scannable)
          if (threatIds.length > 0) {
            return { content: BLOCK_PLACEHOLDER(threatIds), truncated: full.length > max }
          }
          const content = scannable.slice(0, max)
          return {
            content,
            truncated: full.length > content.length,
          }
        }),
    }),
    memory_search: Tool.make({
      description:
        "Search memory files (workspace + global indexes, including notes and sessions) for a query. Returns ranked matching chunks with relative path and line numbers (max_results optional, default 20, max 50). Scaffold content is omitted; threat-laden hits may be BLOCKED. Cite path:line when using a hit in an answer.",
      input: MemorySearchInput,
      output: MemorySearchOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output.matches) }],
      execute: (input) =>
        Effect.gen(function* () {
          const roots = rootsOf()
          const max = Math.min(input.max_results ?? DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS)
          const index = yield* openConfiguredMemoryIndex(fs, roots).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (index !== undefined) {
            let ftsFailed = false
            try {
              yield* ensureIndexed(index, fs, roots).pipe(Effect.catch(() => Effect.void))
              const hits = yield* index.search(ftsQuery(input.query), max * 4).pipe(
                Effect.catch(() => {
                  ftsFailed = true
                  return Effect.succeed([] as Array<{
                    id: number
                    path: string
                    line: number
                    text: string
                    score: number
                    source: "global" | "workspace" | "session"
                    ageDays: number
                    root: "global" | "workspace"
                  }>)
                }),
              )
              if (!ftsFailed) {
                const ranked = rankResults(
                  hits
                    .filter((hit) => !isContentFree(hit.text))
                    .filter((hit) => scanForThreats(hit.text).length === 0)
                    .filter((hit) => scanForThreats(hit.path).length === 0)
                    .map((hit) => ({ ...hit, source: hit.source })),
                ).slice(0, max)
                yield* index
                  .incrementAccess(ranked.map((hit) => ({ id: hit.id, source: hit.source, root: hit.root })))
                  .pipe(Effect.catch(() => Effect.void))
                return {
                  matches: ranked.map((hit) => {
                    const threatIds = scanForThreats(hit.text)
                    const text = threatIds.length > 0 ? BLOCK_PLACEHOLDER(threatIds) : hit.text
                    return { path: hit.path, line: hit.line, text: `${text} ${staleNote(hit.ageDays, hit.source)}`.trim() }
                  }),
                }
              }
              // FTS failed — fall through to grep walk after close.
            } finally {
              yield* index.close().pipe(Effect.catch(() => Effect.void))
            }
          }
          // Fallback walk both roots when the index is unavailable or FTS errors.
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
                if (!info) continue
                const mtime = Option.getOrElse(info.mtime, () => new Date(0)).getTime()
                // Search the head of large files instead of skipping them entirely
                // (FTS indexes full files; grep fallback must still find early hits).
                const rawText = yield* readTextSafe(fs, filePath).pipe(Effect.catch(() => Effect.succeed("")))
                if (!rawText || isContentFree(rawText)) continue
                const text =
                  rawText.length > GREP_FALLBACK_MAX_CHARS
                    ? rawText.slice(0, GREP_FALLBACK_MAX_CHARS)
                    : rawText
                for (const [lineIndex, line] of text.split("\n").entries()) {
                  if (matches.length >= max) break
                  if (line.toLowerCase().includes(query)) {
                    const threatIds = scanForThreats(line)
                    if (threatIds.length > 0) continue
                    if (scanForThreats(path.relative(rootBase, filePath)).length > 0) continue
                    const relative = path.relative(rootBase, filePath).replace(/\\/g, "/")
                    const ageDays = (Date.now() - mtime) / (24 * 60 * 60 * 1000)
                    const note = staleNote(ageDays, relative.startsWith("sessions/") ? "session" : source)
                    matches.push({ path: relative, line: lineIndex + 1, text: `${line} ${note}`.trim() })
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
        "Create one append-only memory note ONLY after the user explicitly asks to remember, forget, or update something. Do NOT write notes unprompted. Notes are later consolidated into MEMORY.md by the background dream process.",
      input: MemoryAddNoteInput,
      output: MemoryAddNoteOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: `Memory note saved: ${output.filename}` }],
      execute: (input) =>
        Effect.gen(function* () {
          const note = input.note.trim()
          if (note.length === 0) return yield* new Tool.Failure({ message: "Note cannot be empty." })
          if (note.length > MAX_NOTE_CHARS) {
            return yield* new Tool.Failure({
              message: `Note exceeds maximum length of ${MAX_NOTE_CHARS} characters.`,
            })
          }
          const threatIds = scanForThreats(note)
          if (threatIds.length > 0) {
            // Do not echo pattern ids (oracle).
            return yield* new Tool.Failure({ message: "Note rejected: disallowed content detected." })
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
