export * as ListDirTool from "./list-dir"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { AbsolutePath } from "../schema"
import { ReadToolFileSystem } from "./read-filesystem"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "list_dir"

const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "Directory path to list. Relative paths resolve from the current location; absolute paths inside it are accepted, while external absolute paths require external_directory approval.",
  }),
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The 1-based directory entry offset to start listing from",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of directory entries to return",
  }),
})
const Output = ReadToolFileSystem.ListPage

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const reader = yield* ReadToolFileSystem.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "List a directory page. Relative paths resolve from the current location; absolute paths inside it are accepted, while external absolute paths require external_directory approval.",
            input: Input,
            output: Output,
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
                yield* permission.assert({
                  action: "read",
                  resources: [resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                return yield* reader.list(absolute, { offset: input.offset, limit: input.limit })
              }).pipe(
                Effect.mapError((error) => {
                  const detail =
                    error instanceof Error && error.message
                      ? error.message
                      : typeof error === "object" && error && "message" in error
                        ? String((error as { message: unknown }).message)
                        : String(error)
                  return new ToolFailure({
                    message: `Unable to list ${input.path}${detail ? ` (${detail})` : ""}`,
                  })
                }),
              )
            },
          }),
          "read",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/list-dir",
  layer,
  deps: [ToolRegistry.node, ReadToolFileSystem.node, LocationMutation.node, PermissionV2.node],
})
