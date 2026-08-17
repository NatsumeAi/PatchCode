export * as GlobTool from "./glob"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { Permission } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "glob"
export const DEFAULT_LIMIT = 100

export const description = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths
- Use this tool when you need to find files by name patterns
- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead
- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.`

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description:
      "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided.",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: "Maximum results to return",
  }),
})

export const Output = Schema.Struct({
  entries: Schema.Array(FileSystem.Entry),
  truncated: Schema.Boolean,
})
type ModelOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput) => {
  const lines =
    output.entries.length === 0 ? ["No files found"] : output.entries.map((item) => item.path)
  if (output.truncated) {
    lines.push("")
    lines.push(
      `(Results are truncated: showing first ${output.entries.length} results. Consider using a more specific path or pattern.)`,
    )
  }
  return lines.join("\n")
}

const source = (context: Tool.Context) => ({
  type: "tool" as const,
  messageID: context.assistantMessageID,
  callID: context.toolCallID,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const ripgrep = yield* Ripgrep.Service
    const fs = yield* FSUtil.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* Permission.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const target = yield* mutation.resolve({
                path: input.path ?? ".",
                kind: "directory",
                sessionID: context.sessionID,
              })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: source(context),
                })
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: input.path ?? ".",
                  path: input.path,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: source(context),
              })
              const cwd = target.canonical
              const info = yield* fs.stat(cwd).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (info?.type === "File")
                return yield* Effect.fail(new Error(`glob path must be a directory: ${cwd}`))
              const limit = input.limit ?? DEFAULT_LIMIT
              const result = yield* ripgrep.glob({
                cwd,
                pattern: input.pattern,
                limit,
                sessionID: context.sessionID,
              })
              const truncated = result.length === limit
              return {
                truncated,
                entries: result.map((entry) =>
                  FileSystem.Entry.make({
                    ...entry,
                    path: RelativePath.make(path.resolve(cwd, entry.path)),
                  }),
                ),
              }
            }).pipe(
              Effect.mapError((error) => {
                const detail = error instanceof Error && error.message ? error.message : ""
                return new ToolFailure({
                  message: detail.includes("must be a directory")
                    ? detail
                    : `Unable to find files matching ${input.pattern}`,
                })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/glob",
  layer,
  deps: [ToolRegistry.node, Ripgrep.node, FSUtil.node, LocationMutation.node, Permission.node],
})
