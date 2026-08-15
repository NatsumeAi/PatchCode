export * as TaskTool from "./task"

import { ToolFailure } from "@opencode-ai/llm"
import { Cause, Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { SessionEvent } from "../session/event"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { SubagentRegistry } from "../session/subagent-registry"
import type { SessionSchema } from "../session/schema"

export const name = "task"

export const CONCURRENCY_SOFT_CAP = 4
export const CONCURRENCY_HARD_CAP = 7
/** Max concurrent subagents of the same subagent_type. */
export const CONCURRENCY_SAME_TYPE_CAP = 2

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
  cwd: Schema.String.pipe(Schema.optional).annotate({
    description: "Subagent working directory (relative to project root)",
  }),
  fork_mode: Schema.optional(Schema.Literals(["PromptOnly", "LastNTurns", "FullHistory"])).annotate({
    description:
      "How much of the parent session trace the subagent receives. PromptOnly (default): no parent trace, only the prompt. LastNTurns: last 50 parent messages. FullHistory: entire parent trace.",
  }),
  persona: Schema.String.pipe(Schema.optional).annotate({
    description: "Named persona override for this spawn (identity instructions for the child)",
  }),
  isolation: Schema.optional(Schema.Literals(["none", "worktree"])).annotate({
    description: "none (default): share project directory. worktree: git worktree under .opencode/worktrees/",
  }),
})

export const Structured = Schema.Struct({
  exit: Schema.optional(Schema.Literals(["running", "completed", "failed", "cancelled", "timeout", "budget_exhausted"])),
  turns: Schema.optional(Schema.Number),
  usage: Schema.optional(Schema.Struct({ input: Schema.Number, output: Schema.Number, cost: Schema.Number })),
  error: Schema.optional(Schema.String),
  resumeFrom: Schema.optional(Schema.String),
})

export const Output = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
  task_id: Schema.String.pipe(Schema.optional),
  sessionID: Schema.String.pipe(Schema.optional),
  /** True when host started a background subagent (TUI foregroundTasks filters on this). */
  background: Schema.Boolean.pipe(Schema.optional),
  /** Structured result contract: exit state, turn/usage counters, resume handle. */
  structured: Schema.optional(Structured),
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
    readonly cwd?: string
    readonly forkMode?: "PromptOnly" | "LastNTurns" | "FullHistory"
    readonly persona?: string
    readonly isolation?: "none" | "worktree"
    readonly agent: string
    readonly assistantMessageID: string
    readonly toolCallID: string
  }) => Effect.Effect<{
    readonly title: string
    readonly output: string
    readonly task_id?: string
    readonly sessionID?: string
    readonly background?: boolean
    readonly structured?: Schema.Schema.Type<typeof Structured>
  }>
}

export class HostService extends Context.Service<HostService, Host>()("@opencode/v2/TaskTool.Host") {}

/**
 * Location-graph placeholder for the task host. The location graph is hoisted
 * (Layer.fresh) and cannot see app-layer globals, so a Location that needs to
 * execute the task tool must provide this service explicitly. App graphs
 * replace it with the real host bridge via buildLocationServiceMap
 * replacements (name-keyed); standalone use (tests) gets a no-op host.
 */
export const hostNode = makeGlobalNode({
  service: HostService,
  layer: Layer.succeed(
    HostService,
    HostService.of({
      run: () =>
        Effect.die(
          new Error(
            "Task host is not available. Subagent spawning requires the opencode task host bridge.",
          ),
        ),
    }),
  ),
  deps: [],
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    // Capture the host at build time: the location graph is hoisted and
    // Layer.provide only exposes the host to node layers while they build —
    // an execute-time serviceOption would always resolve None.
    const capturedHost = yield* Effect.serviceOption(HostService)
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              // V1 published title via ctx.metadata at execute start so a running
              // task part is visible before the host blocks.
              yield* events.publish(SessionEvent.Tool.Progress, {
                sessionID: context.sessionID,
                assistantMessageID: context.assistantMessageID,
                timestamp: yield* DateTime.now,
                callID: context.toolCallID,
                structured: { title: input.description, description: input.description },
                content: [],
              })

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

              // Concurrency: same-type cap → hard cap → soft advisory embedded in failure-free path.
              const registryOpt = yield* Effect.serviceOption(SubagentRegistry.Service)
              let softAdvisory: string | undefined
              if (Option.isSome(registryOpt)) {
                const registry = registryOpt.value
                const active = yield* registry.activeCount
                const byType = yield* registry.activeCountByType(input.subagent_type)
                if (byType >= CONCURRENCY_SAME_TYPE_CAP) {
                  return yield* new ToolFailure({
                    message: `Too many active "${input.subagent_type}" subagents (${byType}, max ${CONCURRENCY_SAME_TYPE_CAP}). Wait for one to finish or use another type.`,
                  })
                }
                if (active >= CONCURRENCY_HARD_CAP) {
                  return yield* new ToolFailure({
                    message: `Too many active subagents (${active}). Solve the task yourself or wait for some to finish.`,
                  })
                }
                if (active >= CONCURRENCY_SOFT_CAP) {
                  softAdvisory = `Note: ${active} subagents are already active; prefer fewer parallel tasks unless necessary.`
                }
              }

              const liveHost = yield* Effect.serviceOption(HostService)
              // Location hoist replaces hostNode at build time (capturedHost).
              // Execute-time HostService can still be the placeholder if the
              // location env kept hostNode; never let that die-stub win.
              const hosts = [liveHost, capturedHost].flatMap((option) =>
                option._tag === "Some" ? [option.value] : [],
              )
              const unique = hosts.filter((host, index) => hosts.indexOf(host) === index)
              if (unique.length === 0) {
                return yield* new ToolFailure({
                  message:
                    "Task host is not available. Subagent spawning requires the opencode task host bridge.",
                })
              }

              const runInput = {
                parentSessionID: context.sessionID,
                description: input.description,
                prompt: input.prompt,
                subagentType: input.subagent_type,
                taskID: input.task_id,
                command: input.command,
                background: input.background,
                cwd: input.cwd,
                forkMode: input.fork_mode,
                persona: input.persona,
                isolation: input.isolation,
                agent: context.agent,
                assistantMessageID: context.assistantMessageID,
                toolCallID: context.toolCallID,
              }
              const tryHost = (
                index: number,
              ): Effect.Effect<Schema.Schema.Type<typeof Output>, ToolFailure> => {
                const host = unique[index]
                if (!host) {
                  return new ToolFailure({
                    message:
                      "Task host is not available. Subagent spawning requires the opencode task host bridge.",
                  })
                }
                return host.run(runInput).pipe(
                  Effect.catchCause((cause) => {
                    if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
                    const message = String(Cause.squash(cause))
                    if (message.includes("Task host is not available") && index + 1 < unique.length) {
                      return tryHost(index + 1)
                    }
                    return new ToolFailure({ message: `Task failed: ${Cause.squash(cause)}` })
                  }),
                )
              }
              const result = yield* tryHost(0)
              if (softAdvisory && result.output) {
                return { ...result, output: `${softAdvisory}\n\n${result.output}` }
              }
              return result
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/task",
  layer,
  // Explicit dependency on the host placeholder: the location graph is hoisted
  // (Layer.fresh) and only injects global services the tree references. The
  // execute-time serviceOption alone would never resolve — the host must be a
  // compile-time dependency of this node so hoist lifts it into the location
  // environment. App graphs replace hostNode with the real bridge.
  deps: [ToolRegistry.node, PermissionV2.node, hostNode, EventV2.node],
})
