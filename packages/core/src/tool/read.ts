export * as ReadTool from "./read"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Image } from "../image"
import { LocationMutation } from "../location-mutation"
import { Permission } from "../permission"
import { AbsolutePath } from "../schema"
import { LspTool } from "./lsp"
import { ReadToolFileSystem } from "./read-filesystem"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { InstructionContext } from "../instruction-context"
import { Location } from "../location"

export const name = "read"
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

export const description = `Read a file or directory from the local filesystem. If the path does not exist, an error is returned.

Usage:
- The path parameter should be an absolute path, or a path relative to the current location.
- By default, this tool returns up to 2000 lines from the start of the file.
- The offset parameter is the line number to start from (1-indexed).
- To read later sections, call this tool again with a larger offset.
- Use the grep tool to find specific content in large files or files with long lines.
- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.
- Contents are returned with each line prefixed by its line number as \`<line>: <content>\`. For example, if a file has contents "foo\\n", you will receive "1: foo\\n". For directories, entries are returned one per line (without line numbers) with a trailing \`/\` for subdirectories.
- Any line longer than 2000 characters is truncated.
- Call this tool in parallel when you know there are multiple files you want to read.
- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.
- This tool can read image files and PDFs and return them as file attachments.`

export const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "The absolute path to the file or directory to read" }),
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The 1-based directory entry or text line offset to start reading from",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of directory entries or text lines to read",
  }),
})

const Output = Schema.Union([FileSystem.Content, ReadToolFileSystem.TextPage, ReadToolFileSystem.ListPage])

const numbered = (content: string, offset: number) => {
  const raw = content.length === 0 ? [] : content.split("\n")
  return raw.map((line, index) => `${index + offset}: ${line}`).join("\n")
}

const formatFile = (filepath: string, content: string, offset = 1, truncated = false, next?: number) => {
  const raw = content.length === 0 ? [] : content.split("\n")
  const last = offset + Math.max(raw.length, 1) - 1
  const body = numbered(content, offset)
  const footer = truncated
    ? `\n\n(Showing lines ${offset}-${last}. Use offset=${next ?? last + 1} to continue.)`
    : `\n\n(End of file - total ${last} lines)`
  return [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n", body, footer, "\n</content>"].join("\n")
}

const formatDirectory = (filepath: string, page: ReadToolFileSystem.ListPage) => {
  const names = page.entries.map((entry) => entry.path)
  return [
    `<path>${filepath}</path>`,
    `<type>directory</type>`,
    `<entries>`,
    names.join("\n"),
    page.truncated
      ? `\n(Showing ${names.length} entries. Use 'offset' parameter to read beyond this page)`
      : `\n(${names.length} entries)`,
    `</entries>`,
  ].join("\n")
}

export const toModelOutput = (input: { path: string }, output: typeof Output.Type) => {
  if ("encoding" in output) {
    if (output.encoding === "base64" && SUPPORTED_IMAGE_MIMES.has(output.mime)) {
      return [
        { type: "text" as const, text: "Image read successfully" },
        { type: "file" as const, data: output.content, mime: output.mime, name: input.path },
      ]
    }
    if (output.encoding === "base64" && output.mime === "application/pdf") {
      return [
        { type: "text" as const, text: "PDF read successfully" },
        { type: "file" as const, data: output.content, mime: output.mime, name: input.path },
      ]
    }
    if (output.encoding === "utf8") {
      return [{ type: "text" as const, text: formatFile(input.path, output.content) }]
    }
    return []
  }
  if ("entries" in output) {
    return [{ type: "text" as const, text: formatDirectory(input.path, output) }]
  }
  return [
    {
      type: "text" as const,
      text: formatFile(input.path, output.content, output.offset, output.truncated, output.next),
    },
  ]
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const reader = yield* ReadToolFileSystem.Service
    const mutation = yield* LocationMutation.Service
    const image = yield* Image.Service
    const permission = yield* Permission.Service
    const fs = yield* FSUtil.Service
    const lsp = yield* Effect.serviceOption(LspTool.HostService)

    const notFound = (error: unknown) => {
      const reason =
        typeof error === "object" && error && "reason" in error
          ? (error as { reason?: { _tag?: string } }).reason
          : undefined
      return reason?._tag === "NotFound"
    }

    const miss = (filepath: string) =>
      Effect.gen(function* () {
        const dir = path.dirname(filepath)
        const base = path.basename(filepath)
        const items = yield* fs.readDirectory(dir).pipe(
          Effect.map((entries) =>
            entries
              .filter(
                (item) =>
                  item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
              )
              .map((item) => path.join(dir, item))
              .slice(0, 3),
          ),
          Effect.catch(() => Effect.succeed([] as string[])),
        )
        const message =
          items.length > 0
            ? `File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`
            : `File not found: ${filepath}`
        return yield* Effect.fail(new ToolFailure({ message }))
      })

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => toModelOutput(input, output),
          execute: (input, context) => {
            return Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.path, kind: "directory", sessionID: context.sessionID })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              const resource = target.resource
              const absolute = AbsolutePath.make(target.canonical)
              const type = yield* reader.inspect(absolute).pipe(
                Effect.catch((error) => (notFound(error) ? miss(input.path) : Effect.fail(error))),
              )
              yield* permission.assert({
                action: name,
                resources: [resource],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              if (type === "directory")
                return yield* reader.list(absolute, { offset: input.offset, limit: input.limit })
              const content = yield* reader.read(absolute, resource, {
                offset: input.offset,
                limit: input.limit,
              })
              if (Option.isSome(lsp)) {
                yield* lsp.value.touchFile(target.canonical, "document").pipe(Effect.ignoreCause)
              }
              const location = yield* Effect.serviceOption(Location.Service)
              if (Option.isSome(location) && !("encoding" in content)) {
                const nearby = yield* InstructionContext.nearby({
                  filepath: target.canonical,
                  messageID: String(context.assistantMessageID),
                  root: location.value.project.directory,
                  ambient: new Set(),
                  already: new Set(),
                }).pipe(Effect.catch(() => Effect.succeed([])))
                if (nearby.length > 0 && "content" in content) {
                  return {
                    ...content,
                    content: `${content.content}\n\n${nearby.map((item) => item.content).join("\n\n")}`,
                  }
                }
              }
              if ("encoding" in content && content.encoding === "base64" && SUPPORTED_IMAGE_MIMES.has(content.mime)) {
                return yield* image
                  .normalize(resource, { ...content, encoding: "base64" })
                  .pipe(Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)))
              }
              if ("encoding" in content && content.encoding === "base64" && content.mime !== "application/pdf")
                return yield* Effect.fail(new ReadToolFileSystem.BinaryFileError({ resource }))
              return content
            }).pipe(
              Effect.mapError((error) => {
                if (
                  error instanceof ReadToolFileSystem.BinaryFileError ||
                  error instanceof ReadToolFileSystem.MediaIngestLimitError ||
                  error instanceof Image.DecodeError ||
                  error instanceof Image.SizeError
                ) {
                  return new ToolFailure({ message: error.message })
                }
                if (error instanceof ToolFailure) return error
                const detail =
                  error instanceof Error && error.message
                    ? error.message
                    : typeof error === "object" && error && "message" in error
                      ? String((error as { message: unknown }).message)
                      : String(error)
                return new ToolFailure({
                  message: `Unable to read ${input.path}${detail ? ` (${detail})` : ""}`,
                })
              }),
            )
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/read",
  layer,
  deps: [
    ToolRegistry.node,
    ReadToolFileSystem.node,
    LocationMutation.node,
    Image.node,
    Permission.node,
    FSUtil.node,
  ],
})
