export * as PromptSubtask from "./prompt-subtask"

import { DateTime, Effect, Option } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionStore } from "./store"
import { PartTable } from "./sql"
import { TaskTool } from "../tool/task"
import { Identifier } from "../id/id"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"

const spawnedKeys = new Set<string>()

const spawnKey = (sessionID: string, prompt: string, agent: string) => `${sessionID}:${agent}:${prompt}`

const taskInputMatches = (input: unknown, prompt: string, agent: string) => {
  const record =
    typeof input === "string"
      ? (() => {
          try {
            return JSON.parse(input) as Record<string, unknown>
          } catch {
            return {} as Record<string, unknown>
          }
        })()
      : input && typeof input === "object"
        ? (input as Record<string, unknown>)
        : {}
  return record.prompt === prompt && (record.subagent_type === agent || record.agent === agent)
}

const alreadySpawned = (
  sessionID: string,
  messages: readonly SessionMessage.Message[],
  rows: ReadonlyArray<{ data: unknown }>,
  prompt: string,
  agent: string,
) => {
  if (spawnedKeys.has(spawnKey(sessionID, prompt, agent))) return true
  if (
    messages.some(
      (message) =>
        message.type === "assistant" &&
        (message.agent === agent || message.agent === undefined) &&
        message.content.some((part) => {
          if (part.type !== "tool" || part.name !== TaskTool.name) return false
          const input = part.state.status === "pending" ? {} : part.state.input
          return taskInputMatches(input, prompt, agent)
        }),
    )
  ) {
    return true
  }
  return rows.some((row) => {
    const data = row.data as {
      type?: string
      tool?: string
      name?: string
      input?: unknown
      state?: { input?: unknown; status?: string }
    }
    if (data.type !== "tool") return false
    if (data.tool !== TaskTool.name && data.name !== TaskTool.name) return false
    return taskInputMatches(data.state?.input ?? data.input, prompt, agent)
  })
}

export const spawnPending = Effect.fn("PromptSubtask.spawnPending")(function* (input: {
  readonly sessionID: SessionSchema.ID
  readonly extras?: ReadonlyArray<{
    readonly prompt: string
    readonly description: string
    readonly agent: string
    readonly command?: string
  }>
}) {
  const sessionID = input.sessionID
  const extras = input.extras ?? []
  const database = yield* Database.Service
  const db = database.db
  const store = yield* SessionStore.Service
  const events = yield* EventV2.Service
  const hostOpt = yield* Effect.serviceOption(TaskTool.HostService)
  const session = yield* store.get(sessionID)
  const messages = yield* store.context(sessionID).pipe(Effect.catch(() => Effect.succeed([] as SessionMessage.Message[])))
  const rows = yield* db
    .select()
    .from(PartTable)
    .where(eq(PartTable.session_id, sessionID))
    .all()
    .pipe(
      Effect.catch(() => Effect.succeed([] as Array<typeof PartTable.$inferSelect>)),
    )

  type Pending = {
    prompt: string
    description: string
    agent: string
    command?: string
  }
  const pending: Pending[] = []

  for (const message of messages) {
    if (message.type !== "user" || !message.parts) continue
    for (const part of message.parts) {
      if (part.type !== "subtask") continue
      if (alreadySpawned(String(sessionID), messages, rows, part.prompt, part.agent)) continue
      pending.push({
        prompt: part.prompt,
        description: part.description,
        agent: part.agent,
        command: part.command,
      })
    }
  }

  for (const row of rows) {
    const data = row.data as { type?: string; prompt?: string; description?: string; agent?: string; command?: string }
    if (data.type !== "subtask" || !data.prompt || !data.agent) continue
    if (alreadySpawned(String(sessionID), messages, rows, data.prompt, data.agent)) continue
    if (pending.some((item) => item.prompt === data.prompt && item.agent === data.agent)) continue
    pending.push({
      prompt: data.prompt,
      description: data.description || data.agent,
      agent: data.agent,
      command: data.command,
    })
  }

  for (const extra of extras) {
    if (alreadySpawned(String(sessionID), messages, rows, extra.prompt, extra.agent)) continue
    if (pending.some((item) => item.prompt === extra.prompt && item.agent === extra.agent)) continue
    pending.push({
      prompt: extra.prompt,
      description: extra.description,
      agent: extra.agent,
      command: extra.command,
    })
  }

  if (pending.length === 0) return 0

  const model =
    session?.model ??
    ModelV2.Ref.make({
      id: ModelV2.ID.make("unknown"),
      providerID: ProviderV2.ID.make("opencode"),
    })

  for (const task of pending) {
    spawnedKeys.add(spawnKey(String(sessionID), task.prompt, task.agent))
    const assistantMessageID = SessionMessage.ID.create()
    const callID = Identifier.ascending("tool")
    const timestamp = yield* DateTime.now
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      timestamp,
      assistantMessageID,
      agent: task.agent,
      model,
    })
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID,
      timestamp,
      assistantMessageID,
      callID,
      name: TaskTool.name,
    })
    const input = {
      prompt: task.prompt,
      description: task.description,
      subagent_type: task.agent,
      ...(task.command === undefined ? {} : { command: task.command }),
    }
    yield* events.publish(SessionEvent.Tool.Input.Ended, {
      sessionID,
      timestamp,
      assistantMessageID,
      callID,
      text: JSON.stringify(input),
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID,
      timestamp,
      assistantMessageID,
      callID,
      tool: TaskTool.name,
      input,
      provider: { executed: false },
    })

    if (Option.isNone(hostOpt)) {
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        callID,
        error: { type: "unknown", message: "Tool execution failed: Task host is not available" },
        provider: { executed: false },
      })
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        finish: "tool-calls",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      continue
    }

    const result = yield* hostOpt.value
      .run({
        parentSessionID: sessionID,
        description: task.description || task.agent,
        prompt: task.prompt,
        subagentType: task.agent,
        command: task.command,
        background: false,
        agent: task.agent,
        assistantMessageID: String(assistantMessageID),
        toolCallID: String(callID),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.succeed({
            _failed: true as const,
            error: String(cause).slice(0, 500),
          }),
        ),
      )

    const ended = yield* DateTime.now
    if (result && "_failed" in result) {
      yield* events.publish(SessionEvent.Tool.Failed, {
        sessionID,
        timestamp: ended,
        assistantMessageID,
        callID,
        error: { type: "unknown", message: `Tool execution failed: ${result.error}` },
        provider: { executed: false },
      })
    } else {
      if (result.sessionID) {
        yield* events.publish(SessionEvent.Tool.Progress, {
          sessionID,
          timestamp: ended,
          assistantMessageID,
          callID,
          structured: {
            sessionId: result.sessionID,
            parentSessionId: sessionID,
            title: result.title,
          },
          content: [{ type: "text", text: result.output }],
        })
      }
      yield* events.publish(SessionEvent.Tool.Success, {
        sessionID,
        timestamp: ended,
        assistantMessageID,
        callID,
        structured: {
          sessionId: result.sessionID,
          parentSessionId: sessionID,
          title: result.title,
        },
        content: [{ type: "text", text: result.output }],
        result: {
          title: result.title,
          output: result.output,
          sessionID: result.sessionID,
          task_id: result.task_id,
          background: result.background,
        },
        provider: { executed: false },
      })
    }
    yield* events.publish(SessionEvent.Step.Ended, {
      sessionID,
      timestamp: ended,
      assistantMessageID,
      finish: "tool-calls",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
  }

  return pending.length
})

export const remember = (sessionID: string, prompt: string, agent: string) => {
  spawnedKeys.add(spawnKey(sessionID, prompt, agent))
}
