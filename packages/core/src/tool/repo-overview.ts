export * as RepoOverviewTool from "./repo-overview"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "node:path"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { AbsolutePath } from "../schema"
import { ReadToolFileSystem } from "./read-filesystem"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "repo_overview"
const MAX_OUTPUT = 8 * 1024
const README_LINES = 80

const Input = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({
    description: "Directory to summarize. Defaults to the active location.",
  }),
})

const Output = Schema.Struct({
  output: Schema.String,
  languages: Schema.Record(Schema.String, Schema.Number),
  head: Schema.optional(Schema.String),
})

const extLang = (file: string) => {
  const ext = path.extname(file).toLowerCase()
  if (!ext) return undefined
  return ext.slice(1)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const reader = yield* ReadToolFileSystem.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Bounded read-only digest of a repository: top-level listing, README snippet, language counts by extension, git HEAD if present. Does not run bash.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const target = yield* mutation.resolve({
                  path: input.path ?? ".",
                  kind: "directory",
                  sessionID: context.sessionID,
                })
                yield* permission.assert({
                  action: "read",
                  resources: [target.resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const root = AbsolutePath.make(target.canonical)
                const listing = yield* reader.list(root, { offset: 1, limit: 40 })
                const languages: Record<string, number> = {}
                for (const entry of listing.entries) {
                  if (entry.type !== "file") continue
                  const lang = extLang(entry.path)
                  if (!lang) continue
                  languages[lang] = (languages[lang] ?? 0) + 1
                }
                const readmeName = listing.entries.find(
                  (entry) => entry.type === "file" && /^readme(\.md|\.txt)?$/i.test(path.basename(entry.path)),
                )
                let readme = ""
                if (readmeName) {
                  const text = yield* fs.readFileStringSafe(path.join(target.canonical, path.basename(readmeName.path)))
                  if (text) readme = text.split(/\r?\n/).slice(0, README_LINES).join("\n")
                }
                let head: string | undefined
                const headRaw = yield* fs.readFileStringSafe(path.join(target.canonical, ".git", "HEAD"))
                if (headRaw) {
                  const ref = headRaw.trim()
                  if (ref.startsWith("ref: ")) {
                    const refPath = path.join(target.canonical, ".git", ref.slice(5).trim())
                    head = (yield* fs.readFileStringSafe(refPath))?.trim() ?? ref
                  } else {
                    head = ref
                  }
                }
                const lines = [
                  `root: ${path.relative(location.directory, target.canonical) || "."}`,
                  "entries:",
                  ...listing.entries.map((entry) => `- ${entry.type} ${entry.path}`),
                  readme ? `\nREADME:\n${readme}` : "",
                  `languages: ${JSON.stringify(languages)}`,
                  head ? `HEAD: ${head}` : "",
                ]
                let output = lines.filter((line) => line.length > 0).join("\n")
                if (output.length > MAX_OUTPUT) output = `${output.slice(0, MAX_OUTPUT)}\n…truncated`
                return { output, languages, ...(head ? { head } : {}) }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  const detail = error instanceof Error ? error.message : String(error)
                  return new ToolFailure({ message: `repo_overview failed${detail ? `: ${detail}` : ""}` })
                }),
              ),
          }),
          "read",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/repo-overview",
  layer,
  deps: [ToolRegistry.node, ReadToolFileSystem.node, LocationMutation.node, PermissionV2.node, FSUtil.node, Location.node],
})
