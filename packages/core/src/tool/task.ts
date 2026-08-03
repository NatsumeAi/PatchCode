export * as TaskTool from "./task"

import { ToolFailure } from "@opencode-ai/llm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import type { SessionSchema } from "../session/schema"

export const name = "task"

export const description = `Launch a new agent to handle complex, multistep tasks autonomously.

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead
- If you are searching for a specific class definition, use the Grep tool instead
- If you are searching for code within 2-3 files, use the Read tool instead

Usage notes:
1. Launch multiple agents concurrently when possible
2. Do not duplicate work the subagent is doing
3. The result includes a task_id you can reuse later to continue the same subagent session
4. Foreground (default) waits for the result; background=true returns immediately`

export const Input = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.String.pipe(Schema.optional).annotate({
    description: "Resume a previous task (continues the same subagent session)",
  }),
  command: Schema.String.pipe(Schema.optional).annotate({ description: "The command that triggered this task" }),
  background: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Run the agent in the background and return immediately",
  }),
})

export const Output = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
  task_id: Schema.String.pipe(Schema.optional),
  sessionID: Schema.String.pipe(Schema.optional),
  /** True when host started a background subagent (TUI foregroundTasks filters on this). */
  background: Schema.Boolean.pipe(Schema.optional),
})

export interface Host {
  readonly run: (input: {
    readonly parentSessionID: SessionSchema.ID
    readonly description: string
    readonly prompt: string
    readonly subagentType: string
    readonly taskID?: string
    readonly command?: string
    readonly background?: boolean
    readonly agent: string
    readonly assistantMessageID: string
    readonly toolCallID: string
  }) => Effect.Effect<{
    readonly title: string
    readonly output: string
    readonly task_id?: string
    readonly sessionID?: string
    readonly background?: boolean
  }>
}

export class HostService extends Context.Service<HostService, Host>()("@opencode/v2/TaskTool.Host") {}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission
                .assert({
                  action: "task",
                  resources: [input.subagent_type],
                  save: [input.subagent_type],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: task" })))

              // Resolve host at execute time so app-layer bridges can provide it.
              const hostOpt = yield* Effect.serviceOption(HostService)
              if (Option.isNone(hostOpt)) {
                return yield* new ToolFailure({
                  message:
                    "Task host is not available. Subagent spawning requires the opencode task host bridge.",
                })
              }

              return yield* hostOpt.value
                .run({
                  parentSessionID: context.sessionID,
                  description: input.description,
                  prompt: input.prompt,
                  subagentType: input.subagent_type,
                  taskID: input.task_id,
                  command: input.command,
                  background: input.background,
                  agent: context.agent,
                  assistantMessageID: context.assistantMessageID,
                  toolCallID: context.toolCallID,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.fail(new ToolFailure({ message: `Task failed: ${String(cause)}` })),
                  ),
                )
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/task",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node],
})
