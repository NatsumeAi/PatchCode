export * as GrepTool from "./grep"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "grep"
export const DEFAULT_LIMIT = 100

export const description = `- Fast content search tool that works with any codebase size
- Searches file contents using regular expressions
- Supports full regex syntax (eg. "log.*Error", "function\\s+\\w+", etc.)
- Filter files by pattern with the include parameter (eg. "*.js", "*.{ts,tsx}")
- Returns file paths and line numbers with matching lines
- Use this tool when you need to find files containing specific patterns
- If you need to identify/count the number of matches within files, use the Bash tool with \`rg\` (ripgrep) directly. Do NOT use \`grep\`.
- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead`

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern.annotate({
    description: "The regex pattern to search for in file contents",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: "Maximum matches to return",
  }),
})

export const Output = Schema.Struct({
  matches: Schema.Array(FileSystem.Match),
  truncated: Schema.Boolean,
})
type ModelOutput = typeof Output.Encoded

/** Format raw search matches into the familiar concise model output. */
export const toModelOutput = (output: ModelOutput) => {
  if (output.matches.length === 0) return "No files found"
  const lines = [
    `Found ${output.matches.length} matches${output.truncated ? " (more matches available)" : ""}`,
  ]
  let current = ""
  for (const match of output.matches) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  if (output.truncated) {
    lines.push("")
    lines.push("(Results truncated. Consider using a more specific path or pattern.)")
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
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (!input.pattern) return yield* Effect.fail(new Error("pattern is required"))
              const resolved = yield* mutation.resolve({
                path: input.path ?? ".",
                kind: "directory",
                sessionID: context.sessionID,
              })
              const external = resolved.externalDirectory
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
                  root: ".",
                  path: input.path,
                  include: input.include,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: source(context),
              })
              const target = resolved.canonical
              const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
              const limit = input.limit ?? DEFAULT_LIMIT
              const result = yield* ripgrep.grep({
                cwd: info?.type === "Directory" ? target : path.dirname(target),
                pattern: input.pattern,
                file: info?.type === "File" ? path.basename(target) : undefined,
                include: input.include,
                limit,
                sessionID: context.sessionID,
              })
              const truncated = result.length === limit
              return {
                truncated,
                matches: result.map((match) =>
                  FileSystem.Match.make({
                    ...match,
                    entry: FileSystem.Entry.make({
                      ...match.entry,
                      path: RelativePath.make(
                        path.resolve(
                          info?.type === "Directory" ? target : path.dirname(target),
                          match.entry.path,
                        ),
                      ),
                    }),
                  }),
                ),
              }
            }).pipe(
              Effect.mapError((error) => {
                const detail = error instanceof Error && error.message ? error.message : ""
                return new ToolFailure({
                  message: detail === "pattern is required" ? detail : `Unable to grep for ${input.pattern}`,
                })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/grep",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, Ripgrep.node, LocationMutation.node, PermissionV2.node],
})
