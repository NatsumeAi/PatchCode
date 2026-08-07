export * as MemoryTools from "./tools"

import path from "path"
import { Effect, Layer, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { Tools } from "../tool/tools"
import { ToolRegistry } from "../tool/registry"
import { Tool } from "../tool/tool"
import { resolveRoots } from "./storage"
import { readTextSafe } from "./storage"
import { resolveScoped, resolveScopedFile, NotFileError, type ScopedPathError } from "./paths"
import { scanForThreats } from "./scan"

const MemoryListInput = Schema.Struct({ path: Schema.optional(Schema.String) })
const MemoryListOutput = Schema.Struct({
  entries: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.Literals(["file", "directory"]) })),
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
      : `Memory path rejected (${error._tag}): ${relative}`,
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
        "List files and directories in the memory folder (root by default). Use memory_read/memory_search to inspect content.",
      input: MemoryListInput,
      output: MemoryListOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
      execute: (input) =>
        Effect.gen(function* () {
          const base = rootsOf().workspaceDir ?? rootsOf().globalDir
          const target = yield* resolveScoped(fs, base, input.path ?? "").pipe(
            Effect.mapError(scopedFailure(input.path ?? "")),
          )
          const entries = yield* fs.readDirectoryEntries(target).pipe(Effect.catch(() => Effect.succeed([])))
          return {
            entries: entries
              .filter((item) => item.type === "file" || item.type === "directory")
              .map((item) => ({ name: item.name, type: item.type === "directory" ? "directory" : "file" })),
          }
        }),
    }),
    memory_read: Tool.make({
      description:
        "Read a memory file by relative path (max_tokens optional, default 1000 tokens; content truncated when larger).",
      input: MemoryReadInput,
      output: MemoryReadOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: output.content }],
      execute: (input) =>
        Effect.gen(function* () {
          const base = rootsOf().workspaceDir ?? rootsOf().globalDir
          const file = yield* resolveScopedFile(fs, base, input.path).pipe(Effect.mapError(scopedFailure(input.path)))
          const text = yield* Effect.orElseSucceed(readTextSafe(fs, file), () => undefined)
          const max = (input.max_tokens ?? 1000) * 4
          const content = (text ?? "").slice(0, max)
          return { content, truncated: (text?.length ?? 0) > max }
        }),
    }),
    memory_search: Tool.make({
      description:
        "Search memory files for a query substring. Returns matching lines with relative path and line numbers (max_results optional, default 20, max 50).",
      input: MemorySearchInput,
      output: MemorySearchOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output.matches) }],
      execute: (input) =>
        Effect.gen(function* () {
          const base = rootsOf().workspaceDir ?? rootsOf().globalDir
          const query = input.query.toLowerCase()
          const max = Math.min(input.max_results ?? DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS)
          const matches: Array<{ path: string; line: number; text: string }> = []

          const walk = (dir: string): Effect.Effect<void> =>
            Effect.gen(function* () {
              const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
              for (const entry of entries) {
                if (matches.length >= max) return
                if (entry.type === "directory") {
                  yield* walk(path.join(dir, entry.name))
                } else if (entry.type === "file" && entry.name.endsWith(".md")) {
                  const filePath = path.join(dir, entry.name)
                  const text = yield* readTextSafe(fs, filePath).pipe(Effect.catch(() => Effect.succeed("")))
                  if (!text) continue
                  for (const [index, line] of text.split("\n").entries()) {
                    if (matches.length >= max) break
                    if (line.toLowerCase().includes(query)) {
                      matches.push({ path: path.relative(base, filePath), line: index + 1, text: line })
                    }
                  }
                }
              }
            })
          yield* walk(base)
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
          const base = rootsOf().workspaceDir ?? rootsOf().globalDir
          const notesDir = path.join(base, "extensions", "ad_hoc", "notes")
          yield* fs.ensureDir(notesDir).pipe(
            Effect.mapError((error) => new Tool.Failure({ message: `Note directory write failed: ${String(error)}` })),
          )
          const filename = `${timestampPrefix()}-${slugFromNote(note)}.md`
          const filePath = path.join(notesDir, filename)
          // Exclusive create: "wx" flag fails with AlreadyExists when the file exists (never overwrite).
          yield* fs.writeFileString(filePath, note, { flag: "wx" }).pipe(
            Effect.mapError((error) =>
              error.reason._tag === "AlreadyExists"
                ? new Tool.Failure({ message: "Note file already exists; retry." })
                : new Tool.Failure({ message: `Note write failed: ${String(error)}` }),
            ),
          )
          return { filename }
        }),
    }),
  }).pipe(Effect.orDie)
})

export const node = makeLocationNode({
  name: "memory-tools",
  layer: Layer.effectDiscard(Effect.suspend(() => registerMemoryTools())),
  deps: [ToolRegistry.node, FSUtil.node, Location.node, Global.node],
})
