export * as SessionProjector from "./projector"

import { and, desc, eq, gt, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { WorkspaceV2 } from "../workspace"
import { SessionContextEpoch } from "./context-epoch"
import { MessageTable, PartTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import type { DeepMutable } from "../schema"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return { cost: value.cost as Usage["cost"], tokens: value.tokens as Usage["tokens"] }
}

function v1AssistantError(message: SessionMessage.Assistant): { error?: { name: string; data: unknown } } {
  if (message.finish === "content-filter") {
    return {
      error: {
        name: "ContentFilterError",
        data: { message: "The response was blocked by the provider's content filter" },
      },
    }
  }
  if (message.error === undefined) return {}
  const text = message.error.message
  if (message.finish === "error" && /overflow|too large|413|prompt too long/i.test(text)) {
    return { error: { name: "ContextOverflowError", data: { message: text } } }
  }
  if (/interrupt|abort/i.test(text)) {
    return { error: { name: "MessageAbortedError", data: { message: text } } }
  }
  return { error: { name: "UnknownError", data: message.error } }
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    metadata: info.metadata,
    sandbox_profile: typeof info.metadata?.sandboxProfile === "string" ? info.metadata.sandboxProfile : "off",
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ? { ...info.revert, messageID: SessionMessage.ID.make(info.revert.messageID) } : null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function messageData(
  info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"],
): typeof MessageTable.$inferInsert.data {
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]): typeof PartTable.$inferInsert.data {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

function run(db: DatabaseService, events: EventV2.Interface, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Message) => {
      if (
        event.durable === undefined &&
        event.type !== SessionEvent.Shell.Progress.type &&
        event.type !== SessionEvent.Tool.Progress.type
      ) {
        return Effect.die("Durable Session event is missing aggregate sequence")
      }
      return Effect.gen(function* () {
        if (event.type === SessionEvent.Shell.Progress.type || event.type === SessionEvent.Tool.Progress.type) {
          const existing = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, SessionMessage.ID.make(message.id)),
                eq(SessionMessageTable.session_id, event.data.sessionID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (existing) {
            const current = decodeRow(existing)
            if (current.type === "shell" && current.time.completed !== undefined) return
            if (current.type === "assistant" && current.time.completed !== undefined) return
          }
        }
        const encoded = encodeMessage(message)
        const { id, type, ...data } = encoded
        yield* db
          .update(SessionMessageTable)
          .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
          .where(
            and(
              eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
              eq(SessionMessageTable.session_id, event.data.sessionID),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* dualWriteLegacy(db, events, event.data.sessionID, message)
      })
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, events, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeRow)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

type LegacySession = {
  directory: string
  agent?: string | null
  model?: { id: string; providerID: string; variant?: string } | null
}

/**
 * Mirror V2 SessionMessage rows into the legacy MessageTable + PartTable shape
 * so TUI `GET /session/:id/message` (MessageV2.page → MessageTable) can display
 * messages written by the V2 runner. Without this, SessionMessageTable fills
 * but the TUI list stays empty.
 */
function legacyMirror(
  sessionID: SessionEvent.Event["data"]["sessionID"],
  message: SessionMessage.Message,
  session: LegacySession,
  parentID?: string,
):
  | {
      message: {
        id: string
        session_id: typeof sessionID
        time_created: number
        data: Record<string, unknown>
      }
      parts: Array<{
        id: string
        message_id: string
        session_id: typeof sessionID
        data: Record<string, unknown>
      }>
    }
  | undefined {
  const timeCreated = DateTime.toEpochMillis(message.time.created)
  const messageID = message.id
  const fallbackModel = {
    providerID: session.model?.providerID ?? "opencode",
    modelID: session.model?.id ?? "unknown",
    ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
  }
  const fallbackAgent = session.agent || "build"
  const path = { cwd: session.directory, root: session.directory }

  if (message.type === "user") {
    const fallbackParts = (): Array<{
      id: string
      message_id: string
      session_id: string
      data: Record<string, unknown>
    }> => {
      const out: Array<{
        id: string
        message_id: string
        session_id: string
        data: Record<string, unknown>
      }> = []
      let index = 0
      const push = (data: Record<string, unknown>) => {
        out.push({
          id: `prt_${messageID}_${index++}`,
          message_id: messageID,
          session_id: sessionID,
          data,
        })
      }
      if (message.parts && message.parts.length > 0) {
        for (const part of message.parts) {
          if (part.type === "text") {
            push({
              type: "text",
              text: part.text,
              ...(part.synthetic === undefined ? {} : { synthetic: part.synthetic }),
            })
            continue
          }
          if (part.type === "file") {
            push({
              type: "file",
              mime: part.mime ?? "application/octet-stream",
              url: part.uri,
              ...(part.name === undefined ? {} : { filename: part.name }),
              ...(part.source === undefined ? {} : { source: part.source }),
            })
            continue
          }
          if (part.type === "agent") {
            const source = part.source
            const mapped =
              source && typeof source === "object"
                ? "value" in source
                  ? source
                  : "text" in source && "start" in source && "end" in source
                    ? {
                        value: String((source as { text: unknown }).text),
                        start: Number((source as { start: unknown }).start),
                        end: Number((source as { end: unknown }).end),
                      }
                    : undefined
                : undefined
            push({
              type: "agent",
              name: part.name,
              ...(mapped === undefined ? {} : { source: mapped }),
            })
            continue
          }
          push({
            type: "subtask",
            prompt: part.prompt,
            description: part.description,
            agent: part.agent,
            ...(part.command === undefined ? {} : { command: part.command }),
            ...(part.model === undefined ? {} : { model: part.model }),
          })
        }
        return out
      }
      if (message.text) push({ type: "text", text: message.text })
      for (const file of message.files ?? []) {
        push({
          type: "file",
          mime: file.mime,
          url: file.uri,
          ...(file.name === undefined ? {} : { filename: file.name }),
          ...(file.source === undefined ? {} : { source: file.source }),
        })
      }
      for (const agent of message.agents ?? []) {
        push({
          type: "agent",
          name: agent.name,
          ...(agent.source === undefined
            ? {}
            : {
                source: {
                  value: agent.source.text,
                  start: agent.source.start,
                  end: agent.source.end,
                },
              }),
        })
      }
      if (out.length === 0) push({ type: "text", text: message.text ?? "" })
      return out
    }
    return {
      message: {
        id: messageID,
        session_id: sessionID,
        time_created: timeCreated,
        data: {
          role: "user" as const,
          time: { created: timeCreated },
          agent: fallbackAgent,
          model: fallbackModel,
          summary: { diffs: [] },
        },
      },
      parts: fallbackParts(),
    }
  }

  if (message.type === "shell") {
    const completed =
      message.time.completed === undefined ? undefined : DateTime.toEpochMillis(message.time.completed)
    const body = ["$ " + message.command, message.output].filter(Boolean).join("\n")
    return {
      message: {
        id: messageID,
        session_id: sessionID,
        time_created: timeCreated,
        data: {
          role: "assistant" as const,
          parentID: parentID ?? messageID,
          agent: fallbackAgent,
          mode: fallbackAgent,
          modelID: fallbackModel.modelID,
          providerID: fallbackModel.providerID,
          path,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: {
            created: timeCreated,
            ...(completed === undefined ? {} : { completed }),
          },
          ...(completed === undefined ? {} : { finish: "stop" as const }),
        },
      },
      parts: [
        {
          id: `prt_${messageID}_shell`,
          message_id: messageID,
          session_id: sessionID,
          data: {
            type: "tool" as const,
            tool: "bash",
            callID: message.callID,
            state:
              completed === undefined
                ? {
                    status: "running" as const,
                    input: { command: message.command },
                    title: "bash",
                    metadata: { output: message.output ?? "" },
                    time: { start: timeCreated },
                  }
                : {
                    status: "completed" as const,
                    input: { command: message.command },
                    output: message.output ?? "",
                    title: "bash",
                    metadata: {
                      output: message.output ?? "",
                      ...(message.exit === undefined ? {} : { exit: message.exit }),
                    },
                    time: {
                      start: timeCreated,
                      end: completed,
                    },
                  },
          },
        },
        {
          id: `prt_${messageID}_text`,
          message_id: messageID,
          session_id: sessionID,
          data: { type: "text" as const, text: body },
        },
      ],
    }
  }

  if (message.type === "assistant") {
    const completed =
      message.time.completed === undefined ? undefined : DateTime.toEpochMillis(message.time.completed)
    const first = message.time.first === undefined ? undefined : DateTime.toEpochMillis(message.time.first)
    const tokens = message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    return {
      message: {
        id: messageID,
        session_id: sessionID,
        time_created: timeCreated,
        data: {
          role: "assistant" as const,
          // v1 Assistant requires parentID; fall back to self only when no prior user exists
          parentID: parentID ?? messageID,
          agent: message.agent || fallbackAgent,
          mode: message.agent || fallbackAgent,
          modelID: message.model.id,
          providerID: message.model.providerID,
          path,
          cost: message.cost ?? 0,
          tokens: {
            total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
            input: tokens.input,
            output: tokens.output,
            reasoning: tokens.reasoning,
            cache: tokens.cache,
          },
          time: {
            created: timeCreated,
            ...(first === undefined ? {} : { first }),
            ...(completed === undefined ? {} : { completed }),
          },
          ...(message.finish === undefined ? {} : { finish: message.finish }),
          ...(message.model.variant === undefined ? {} : { variant: message.model.variant }),
          ...v1AssistantError(message),
        },
      },
      parts: message.content.map((part) => {
        const id = `prt_${messageID}_${part.id}`
        if (part.type === "text") {
          return {
            id,
            message_id: messageID,
            session_id: sessionID,
            data: { type: "text" as const, text: part.text },
          }
        }
        if (part.type === "reasoning") {
          const start = part.time?.created === undefined ? undefined : DateTime.toEpochMillis(part.time.created)
          const end =
            part.time?.completed === undefined ? undefined : DateTime.toEpochMillis(part.time.completed)
          return {
            id,
            message_id: messageID,
            session_id: sessionID,
            data: {
              type: "reasoning" as const,
              text: part.text,
              ...(start === undefined
                ? {}
                : { time: { start, ...(end === undefined ? {} : { end }) } }),
            },
          }
        }
        const tool = part
        const state = tool.state
        const start = DateTime.toEpochMillis(tool.time.created)
        const end = DateTime.toEpochMillis(tool.time.completed ?? tool.time.created)
        const rawInput = state.input ?? {}
        // V1 tool parts expect Record input; V2 pending carries a JSON string.
        const asObject = (value: unknown): Record<string, unknown> => {
          if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
          if (typeof value === "string" && value.length > 0) {
            try {
              const parsed = JSON.parse(value) as unknown
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>
              }
            } catch {
              // Keep the raw string when the tool input is not JSON.
            }
            return { value }
          }
          return {}
        }
        const input = asObject(rawInput)
        const nested = typeof input.value === "string" ? asObject(input.value) : {}
        const fields = { ...nested, ...input }
        const outputText = () => {
          if (!("content" in state) || !Array.isArray(state.content)) return ""
          return state.content
            .map((item: { type?: string; text?: string }) => (item.type === "text" ? item.text ?? "" : ""))
            .filter(Boolean)
            .join("\n")
        }
        const out = outputText()
        const structured =
          "structured" in state && state.structured && typeof state.structured === "object"
            ? (state.structured as Record<string, unknown>)
            : {}
        const title =
          (typeof fields.description === "string" && fields.description.length > 0
            ? fields.description
            : undefined) ??
          (typeof structured.title === "string" && structured.title.length > 0 ? structured.title : undefined) ??
          (typeof structured.description === "string" && structured.description.length > 0
            ? structured.description
            : undefined) ??
          tool.name
        const childSession =
          (typeof structured.sessionId === "string" && structured.sessionId) ||
          (typeof structured.sessionID === "string" && structured.sessionID) ||
          (typeof structured.task_id === "string" && structured.task_id) ||
          undefined
        const taskMeta =
          tool.name === "task"
            ? { parentSessionId: sessionID, ...(childSession ? { sessionId: childSession } : {}) }
            : {}
        const outputPaths =
          "outputPaths" in state && Array.isArray(state.outputPaths)
            ? state.outputPaths.filter((item): item is string => typeof item === "string")
            : []
        const truncated = outputPaths.length > 0
        const outputPath = outputPaths[0]
        const v1Output =
          truncated && outputPath
            ? `${out}\n\n...output truncated...\n\nFull output saved to: ${outputPath}`
            : out
        const truncMeta = truncated
          ? { truncated: true as const, outputPath, output: v1Output }
          : { output: v1Output }
        // Shell display reads metadata.output; generic/task read state.output.
        const toolState =
          state.status === "completed"
            ? {
                status: "completed" as const,
                input: fields,
                output: v1Output,
                title,
                metadata: { ...taskMeta, ...structured, ...truncMeta },
                time: { start, end },
              }
            : state.status === "error"
              ? {
                  status: "error" as const,
                  input: fields,
                  error: state.error?.message ?? "tool error",
                  metadata: { ...taskMeta, ...structured, ...(out ? { output: out } : {}) },
                  time: { start, end },
                }
              : {
                  status: "running" as const,
                  input: fields,
                  title,
                  metadata: { ...taskMeta, ...structured, output: out },
                  time: { start },
                }
        return {
          id,
          message_id: messageID,
          session_id: sessionID,
          data: {
            type: "tool" as const,
            tool: tool.name,
            callID: tool.id,
            state: toolState,
          },
        }
      }),
    }
  }

  if (message.type === "synthetic" || message.type === "system") {
    return {
      message: {
        id: messageID,
        session_id: sessionID,
        time_created: timeCreated,
        data: {
          role: "user" as const,
          time: { created: timeCreated },
          agent: fallbackAgent,
          model: fallbackModel,
          summary: { diffs: [] },
        },
      },
      parts: [
        {
          id: `prt_${messageID}_text`,
          message_id: messageID,
          session_id: sessionID,
          data: {
            type: "text" as const,
            text: message.text,
            synthetic: true,
          },
        },
      ],
    }
  }

  if (message.type === "compaction") {
    return {
      message: {
        id: messageID,
        session_id: sessionID,
        time_created: timeCreated,
        data: {
          role: "user" as const,
          time: { created: timeCreated },
          agent: fallbackAgent,
          model: fallbackModel,
          summary: { diffs: [] },
        },
      },
      parts: [
        {
          id: `prt_${messageID}_text`,
          message_id: messageID,
          session_id: sessionID,
          data: { type: "text" as const, text: message.summary },
        },
        {
          id: `prt_${messageID}_compaction`,
          message_id: messageID,
          session_id: sessionID,
          data: {
            type: "compaction" as const,
            auto: message.reason === "auto",
          },
        },
      ],
    }
  }

  return undefined
}

function dualWriteLegacy(
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionEvent.Event["data"]["sessionID"],
  message: SessionMessage.Message,
) {
  return Effect.gen(function* () {
    const session = yield* db
      .select({
        directory: SessionTable.directory,
        agent: SessionTable.agent,
        model: SessionTable.model,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    if (!session) return

    let parentID: string | undefined
    if (message.type === "assistant" || message.type === "shell") {
      const existing = yield* db
        .select({ data: MessageTable.data })
        .from(MessageTable)
        .where(eq(MessageTable.id, message.id as (typeof MessageTable.$inferSelect)["id"]))
        .get()
        .pipe(Effect.orDie)
      const recorded = (existing?.data as { parentID?: string } | undefined)?.parentID
      if (recorded) {
        parentID = recorded
      } else {
        const legacyUsers = yield* db
          .select({ id: MessageTable.id, data: MessageTable.data })
          .from(MessageTable)
          .where(eq(MessageTable.session_id, sessionID))
          .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
          .limit(20)
          .all()
          .pipe(Effect.orDie)
        for (const row of legacyUsers) {
          const data = row.data as { role?: string }
          if (data.role !== "user") continue
          const partRows = yield* db
            .select({ data: PartTable.data })
            .from(PartTable)
            .where(eq(PartTable.message_id, row.id))
            .all()
            .pipe(Effect.orDie)
          const syntheticOnly =
            partRows.length > 0 &&
            partRows.every((part) => {
              const partData = part.data as { type?: string; synthetic?: boolean }
              return partData.type === "text" && partData.synthetic === true
            })
          if (syntheticOnly) continue
          parentID = String(row.id)
          break
        }
        if (!parentID) {
          const parent = yield* db
            .select({ id: SessionMessageTable.id, type: SessionMessageTable.type })
            .from(SessionMessageTable)
            .where(eq(SessionMessageTable.session_id, sessionID))
            .orderBy(desc(SessionMessageTable.seq))
            .limit(50)
            .all()
            .pipe(Effect.orDie)
          for (const row of parent) {
            if (String(row.id) === String(message.id)) continue
            if (row.type === "user") {
              parentID = String(row.id)
              break
            }
          }
        }
      }
    }

    const mirror = legacyMirror(sessionID, message, session, parentID)
    if (!mirror) return

    // Brand IDs (Session.Message.ID vs MessageID) differ at the type level but are
    // the same msg_… strings at rest. Cast at the storage boundary so dual-write
    // cannot fail the durable V2 projection on type mismatch.
    const messageRow = {
      id: mirror.message.id as (typeof MessageTable.$inferInsert)["id"],
      session_id: mirror.message.session_id as (typeof MessageTable.$inferInsert)["session_id"],
      time_created: mirror.message.time_created,
      data: mirror.message.data as (typeof MessageTable.$inferInsert)["data"],
    }

    yield* db
      .insert(MessageTable)
      .values(messageRow)
      .onConflictDoUpdate({
        target: MessageTable.id,
        set: { data: messageRow.data, time_created: messageRow.time_created },
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .delete(PartTable)
      .where(eq(PartTable.message_id, messageRow.id))
      .run()
      .pipe(Effect.orDie)
    const now = Date.now()
    for (const part of mirror.parts) {
      yield* db
        .insert(PartTable)
        .values({
          id: part.id as (typeof PartTable.$inferInsert)["id"],
          message_id: messageRow.id,
          session_id: messageRow.session_id,
          time_created: now,
          data: part.data as (typeof PartTable.$inferInsert)["data"],
        })
        .run()
        .pipe(Effect.orDie)
    }

    // NOTE: do NOT publish SessionV1.Event.MessageUpdated here — it is durable
    // and steals event seq (UNIQUE constraint) / needs InstanceRef. Live TUI
    // paint for V2 is handled by session.next.* → sync store bridge.
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("legacy dual-write failed", { sessionID, messageID: message.id, cause }).pipe(Effect.asVoid),
    ),
  )
}

function insertMessage(
  db: DatabaseService,
  events: EventV2.Interface,
  event: SessionEvent.Event,
  message: SessionMessage.Message,
) {
  if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return Effect.gen(function* () {
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: SessionMessage.ID.make(id),
        session_id: event.data.sessionID,
        type,
        seq: event.durable!.seq,
        time_created: DateTime.toEpochMillis(message.time.created),
        data,
      })
      .run()
      .pipe(Effect.orDie)
    yield* dualWriteLegacy(db, events, event.data.sessionID, message)
  })
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) => {
      const row = sessionRow(event.data.info)
      const next =
        typeof event.data.info.metadata?.sandboxProfile === "string"
          ? row
          : (({ sandbox_profile: _ignored, ...rest }) => rest)(row)
      return db.update(SessionTable).set(next).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie)
    })
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
    yield* events.project(SessionV1.Event.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
    )
    yield* events.project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        const time_created = event.data.info.time.created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        yield* db
          .insert(MessageTable)
          .values({ id, session_id: sessionID, time_created, data })
          .onConflictDoUpdate({ target: MessageTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const previous = usage(row.data)
          if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        // Drop V1 parts + message so dual-read history does not resurrect them.
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
        // V2 durable table is append-only for live events; hard-delete the row so
        // session.next / v2.session.messages fallback cannot revive deleted messages.
        yield* db
          .delete(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.id, SessionMessage.ID.make(String(event.data.messageID))),
              eq(SessionMessageTable.session_id, event.data.sessionID),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.id, SessionMessage.ID.make(String(event.data.messageID))),
              eq(SessionInputTable.session_id, event.data.sessionID),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        const row = yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
        yield* db
          .insert(PartTable)
          .values({ id, message_id: messageID, session_id: sessionID, time_created: event.data.time, data })
          .onConflictDoUpdate({ target: PartTable.id, set: { data } })
          .run()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        const next = usage(event.data.part)
        if (previous) yield* applyUsage(db, row.session_id, previous, -1)
        if (next) yield* applyUsage(db, sessionID, next)
      }),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({
          agent: event.data.agent,
          plan_mode: event.data.agent === "plan" ? 1 : 0,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, events, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, events, event)
      }),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
        })
        yield* run(db, events, event)
      }),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.ContextUpdated, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Shell.Progress, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Step.Ended, (event) =>
      Effect.gen(function* () {
        yield* run(db, events, event)
        // V2 usage lives on Step.Ended (not V1 step-finish parts). Accumulate into
        // SessionTable so session.cost / stats stay accurate for the V2 runner path.
        yield* applyUsage(db, event.data.sessionID, {
          cost: event.data.cost,
          tokens: event.data.tokens,
        })
      }),
    )
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, events, event))
    // yield* events.project(SessionEvent.Retried, (event) => run(db, events, event))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => run(db, events, event))
    yield* events.project(SessionEvent.RevertEvent.Staged, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: { ...event.data.revert, files: event.data.revert.files ? [...event.data.revert.files] : undefined },
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        const boundary = yield* db
          .select({ seq: SessionMessageTable.seq, time: SessionMessageTable.time_created })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, event.data.sessionID),
              eq(SessionMessageTable.id, event.data.messageID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!boundary) {
          // Boundary may have been deleted while revert stayed staged. Clear the
          // stuck field instead of dying so later prompt/shell commit can proceed.
          yield* db
            .update(SessionTable)
            .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
            .where(eq(SessionTable.id, event.data.sessionID))
            .run()
            .pipe(Effect.orDie, Effect.asVoid)
          return
        }
        const removed = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
          )
          .all()
          .pipe(Effect.orDie)
        for (const row of removed) {
          const message = decodeMessage({ ...row.data, id: row.id, type: row.type })
          if (message.type !== "assistant") continue
          if (message.tokens === undefined && message.cost === undefined) continue
          const tokens = message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          yield* applyUsage(
            db,
            event.data.sessionID,
            { cost: message.cost ?? 0, tokens },
            -1,
          )
        }
        yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, event.data.sessionID),
              or(gt(SessionInputTable.admitted_seq, boundary.seq), gt(SessionInputTable.promoted_seq, boundary.seq)),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        // Drop the legacy MessageTable/PartTable tail too (dual-read history),
        // so V2 revert does not leave ghost messages in the TUI's V1 store.
        const legacy = yield* db
          .select({ id: MessageTable.id })
          .from(MessageTable)
          .where(
            and(
              eq(MessageTable.session_id, event.data.sessionID),
              or(
                gt(MessageTable.time_created, boundary.time),
                and(
                  eq(MessageTable.time_created, boundary.time),
                  // Brand IDs are the same msg_… strings at rest (see dual-write).
                  gt(MessageTable.id, String(event.data.messageID) as (typeof MessageTable.$inferSelect)["id"]),
                ),
              ),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        for (const row of legacy) {
          const previous = yield* db
            .select()
            .from(PartTable)
            .where(and(eq(PartTable.message_id, row.id), eq(PartTable.session_id, event.data.sessionID)))
            .all()
            .pipe(Effect.orDie)
          for (const part of previous) {
            const usageValue = usage(part.data)
            if (usageValue) yield* applyUsage(db, event.data.sessionID, usageValue, -1)
          }
          yield* db
            .delete(PartTable)
            .where(and(eq(PartTable.message_id, row.id), eq(PartTable.session_id, event.data.sessionID)))
            .run()
            .pipe(Effect.orDie)
          yield* db
            .delete(MessageTable)
            .where(and(eq(MessageTable.id, row.id), eq(MessageTable.session_id, event.data.sessionID)))
            .run()
            .pipe(Effect.orDie)
        }
        yield* db
          .update(SessionTable)
          .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
    // Live-only Progress events are not durable, so events.project never runs.
    // Dual-write V1 running metadata for TUI + tests (same cadence as V1 updatePart).
    const unsubProgress = yield* events.listen((event) => {
      if (
        event.type !== SessionEvent.Shell.Progress.type &&
        event.type !== SessionEvent.Tool.Progress.type
      ) {
        return Effect.void
      }
      return run(db, events, event)
    })
    yield* Effect.addFinalizer(() => unsubProgress)
  }),
)

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })
