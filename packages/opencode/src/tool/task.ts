import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ForkMode } from "@opencode-ai/core/session/loop-control/fork-mode"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"
import { SessionRuntime } from "@opencode-ai/core/session/runtime"
import { TaskTool as CoreTaskTool } from "@opencode-ai/core/tool/task"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Session } from "@/session/session"
import { SessionID } from "../session/schema"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Effect, Option, Schema } from "effect"
import { RuntimeFlags } from "@/effect/runtime-flags"

/** Still passed by SessionPrompt tool extra. Spawn no longer reads it — Host is the only drain. */
export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"

export function makeLoopEventPublisher(
  maybeInstance: Option.Option<SessionRuntime.Instance>,
): (event: EventBus.LoopControlEvent) => Effect.Effect<void> {
  return (event) =>
    Option.isSome(maybeInstance)
      ? maybeInstance.value.eventBus.publish(event)
      : Effect.gen(function* () {
          const maybe = yield* Effect.serviceOption(EventBus.Service)
          if (Option.isSome(maybe)) yield* maybe.value.publish(event)
        })
}

const BACKGROUND_DESCRIPTION = [
  "Background mode: background=true launches the subagent asynchronously and returns immediately.",
  "Foreground is the default; use it when you need the result before continuing.",
  "Use background only for independent work that can run while you continue elsewhere.",
  "You will be notified automatically when it finishes.",
].join(" ")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({
    description: "The command that triggered this task",
  }),
  fork_mode: Schema.optional(ForkMode).annotate({
    description:
      "How much of the parent session trace the subagent receives. PromptOnly (default): no parent trace, only the prompt. LastNTurns: last 50 parent messages. FullHistory: entire parent trace.",
  }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

function abortable<A, E, R>(effect: Effect.Effect<A, E, R>, signal: AbortSignal) {
  const abort = Effect.callback<never>((resume) => {
    if (signal.aborted) return resume(Effect.interrupt)
    const handler = () => resume(Effect.interrupt)
    signal.addEventListener("abort", handler, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", handler))
  })
  return Effect.raceFirst(effect, abort as Effect.Effect<never, E, R>)
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const flags = yield* RuntimeFlags.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const v2Host = yield* Effect.serviceOption(CoreTaskTool.HostService)
      if (Option.isNone(v2Host)) {
        return yield* Effect.fail(
          new Error("Task host is not available. Subagent spawning requires the opencode task host bridge."),
        )
      }

      yield* ctx.metadata({
        title: params.description,
        metadata: {
          parentSessionId: ctx.sessionID,
          ...(runInBackground ? { background: true } : {}),
        },
      })

      const exit = yield* abortable(
        v2Host.value.run({
          parentSessionID: SessionSchema.ID.make(String(ctx.sessionID)),
          description: params.description,
          prompt: params.prompt,
          subagentType: params.subagent_type,
          taskID: params.task_id,
          command: params.command,
          background: runInBackground,
          forkMode: params.fork_mode,
          agent: ctx.agent,
          assistantMessageID: String(ctx.messageID),
          toolCallID: String(ctx.callID ?? "task"),
        }),
        ctx.abort,
      ).pipe(Effect.exit)
      if (exit._tag === "Failure") {
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return yield* Effect.failCause(exit.cause)
        }
        return yield* Effect.fail(new Error(`Task failed: ${Cause.squash(exit.cause)}`))
      }
      const result = exit.value
      const childID = result.sessionID ?? result.task_id
      const exitTag = result.structured?.exit
      const isBackground = result.background === true || exitTag === "running"
      const state: "running" | "completed" | "error" = isBackground
        ? "running"
        : exitTag === "failed" || exitTag === "cancelled" || exitTag === "timeout"
          ? "error"
          : "completed"
      const output = childID
        ? renderOutput({
            sessionID: SessionID.make(String(childID)),
            state,
            text: result.output,
            ...(isBackground ? { summary: "Background task started" } : {}),
          })
        : result.output
      return {
        title: result.title,
        output,
        metadata: {
          ...(childID ? { sessionId: childID } : {}),
          ...(isBackground ? { background: true } : {}),
          ...(result.structured ? { structured: result.structured } : {}),
        },
      }
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
