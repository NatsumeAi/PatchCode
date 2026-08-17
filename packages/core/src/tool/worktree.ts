export * as WorktreeTool from "./worktree"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { Permission } from "../permission"
import { WorktreeEngine } from "../worktree-engine"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "worktree"

const Input = Schema.Struct({
  action: Schema.Literals(["diff", "merge", "discard"]).annotate({
    description: "diff: unified diff vs HEAD; merge: copy child changes onto a clean parent; discard: release the worktree",
  }),
  id: Schema.String.annotate({ description: "Worktree id (child session id when isolation is worktree)" }),
})

const Output = Schema.Struct({
  id: Schema.String,
  action: Schema.String,
  diff: Schema.String.pipe(Schema.optional),
  output: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* Permission.Service
    const location = yield* Location.Service
    const engine = yield* WorktreeEngine.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Preview, merge, or discard an isolated git worktree created by task isolation: worktree. Merge fails if the parent working tree is dirty on the same paths.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* permission
                  .assert({
                    action: "task",
                    resources: ["worktree"],
                    save: ["worktree"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                  .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: worktree" })))

                const projectRoot = location.directory
                if (input.action === "diff") {
                  const diff = yield* engine.previewDiff({ projectRoot, id: input.id })
                  return { id: input.id, action: input.action, diff, output: diff || "(empty diff)" }
                }
                if (input.action === "merge") {
                  yield* engine.merge({ projectRoot, id: input.id, sessionID: String(context.sessionID) })
                  return { id: input.id, action: input.action, output: `Merged worktree ${input.id}` }
                }
                yield* engine.discard({ projectRoot, id: input.id })
                return { id: input.id, action: input.action, output: `Discarded worktree ${input.id}` }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  const tag = error && typeof error === "object" && "_tag" in error ? String(error._tag) : ""
                  const message =
                    error instanceof Error && error.message
                      ? error.message
                      : tag
                        ? tag
                        : String(error)
                  return new ToolFailure({
                    message: `worktree ${input.action} failed${message ? `: ${message}` : ""}`,
                  })
                }),
              ),
          }),
          "task",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/worktree",
  layer,
  deps: [ToolRegistry.node, Permission.node, Location.node, WorktreeEngine.node],
})
