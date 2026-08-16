/**
 * Map V2 session.next / SessionMessage shapes onto the V1 Message+Part store
 * that the TUI session route still renders from.
 *
 * Why: the V2 runner dual-writes MessageTable for GET /session/:id/message, but
 * live paint historically depended on durable message.updated events. Publishing
 * those from dual-write steals event seq (UNIQUE) and needs InstanceRef. The
 * session UI never read the data store that consumes session.next.*, so the
 * transcript stayed blank during/after V2 turns until a lucky re-fetch.
 */
import type {
  AssistantMessage,
  Message,
  Part,
  ReasoningPart,
  Session,
  SessionMessage,
  TextPart,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { toEpochMsOr } from "../util/epoch-ms"

export type LegacySessionMeta = {
  agent: string
  model: { providerID: string; modelID: string; variant?: string }
  directory: string
}

export function sessionMeta(session: Session | undefined): LegacySessionMeta {
  return {
    agent: session?.agent || "build",
    model: {
      providerID: session?.model?.providerID ?? "opencode",
      modelID: session?.model?.id ?? "unknown",
      ...(session?.model?.variant === undefined ? {} : { variant: session.model.variant }),
    },
    directory: session?.directory ?? "",
  }
}

/** Coerce event timestamps (epoch ms | ISO | DateTime-like) to epoch ms. */
function ts(value: unknown, fallback = Date.now()) {
  return toEpochMsOr(value, fallback)
}

export function userMessageFromPrompt(input: {
  sessionID: string
  messageID: string
  text: string
  timestamp: number
  meta: LegacySessionMeta
}): UserMessage {
  return {
    id: input.messageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: ts(input.timestamp) },
    agent: input.meta.agent,
    model: input.meta.model,
    summary: { diffs: [] },
  }
}

export function userTextPart(input: {
  sessionID: string
  messageID: string
  text: string
  synthetic?: boolean
}): TextPart {
  return {
    id: `prt_${input.messageID}_text`,
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "text",
    text: input.text,
    ...(input.synthetic ? { synthetic: true } : {}),
  }
}

export function assistantMessageFromStep(input: {
  sessionID: string
  messageID: string
  agent: string
  model: { id: string; providerID: string; variant?: string }
  timestamp: number
  parentID?: string
  directory: string
}): AssistantMessage {
  const created = ts(input.timestamp)
  return {
    id: input.messageID,
    sessionID: input.sessionID,
    role: "assistant",
    parentID: input.parentID ?? input.messageID,
    agent: input.agent || "build",
    mode: input.agent || "build",
    modelID: input.model.id,
    providerID: input.model.providerID,
    path: { cwd: input.directory, root: input.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created },
    ...(input.model.variant === undefined ? {} : { variant: input.model.variant }),
  }
}

export function textPartID(messageID: string, textID: string) {
  return `prt_${messageID}_${textID}`
}

export function reasoningPartID(messageID: string, reasoningID: string) {
  return `prt_${messageID}_${reasoningID}`
}

export function toolPartID(messageID: string, callID: string) {
  return `prt_${messageID}_${callID}`
}

export function emptyTextPart(input: {
  sessionID: string
  messageID: string
  textID: string
  start?: number
}): TextPart {
  return {
    id: textPartID(input.messageID, input.textID),
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "text",
    text: "",
    // Chronological insert needs a start time so text sorts before later tools.
    time: { start: input.start ?? Date.now() },
  }
}

export function emptyReasoningPart(input: {
  sessionID: string
  messageID: string
  reasoningID: string
  start?: number
}): ReasoningPart {
  return {
    id: reasoningPartID(input.messageID, input.reasoningID),
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "reasoning",
    text: "",
    // Always set start so duration wiring has a baseline once ended arrives.
    time: { start: input.start ?? Date.now() },
  }
}

export function toolPartPending(input: {
  sessionID: string
  messageID: string
  callID: string
  name: string
  start: number
}): ToolPart {
  return {
    id: toolPartID(input.messageID, input.callID),
    sessionID: input.sessionID,
    messageID: input.messageID,
    type: "tool",
    tool: input.name,
    callID: input.callID,
    state: {
      status: "running",
      input: {},
      time: { start: input.start },
    },
  }
}

function toolOutputText(content: Array<{ type?: string; text?: string }> | undefined) {
  if (!content) return ""
  return content
    .map((item) => (item.type === "text" ? item.text ?? "" : ""))
    .filter(Boolean)
    .join("\n")
}

/** Convert a projected V2 SessionMessage into V1 Message + Part[] for the sync store. */
export function sessionMessageToLegacy(
  sessionID: string,
  message: SessionMessage,
  meta: LegacySessionMeta,
  parentID?: string,
): { info: Message; parts: Part[] } | undefined {
  const created = ts(message.time.created)

  if (message.type === "user") {
    const parts: Part[] = [
      userTextPart({
        sessionID,
        messageID: message.id,
        text: message.text,
      }),
    ]
    for (const [index, file] of (message.files ?? []).entries()) {
      parts.push({
        id: `prt_${message.id}_file_${index}`,
        sessionID,
        messageID: message.id,
        type: "file",
        url: file.uri,
        mime: file.mime ?? "application/octet-stream",
        filename: file.name ?? file.uri.split("/").at(-1) ?? file.uri,
      })
    }
    for (const [index, agent] of (message.agents ?? []).entries()) {
      parts.push({
        id: `prt_${message.id}_agent_${index}`,
        sessionID,
        messageID: message.id,
        type: "agent",
        name: agent.name,
      })
    }
    return {
      info: userMessageFromPrompt({
        sessionID,
        messageID: message.id,
        text: message.text,
        timestamp: created,
        meta,
      }),
      parts,
    }
  }

  if (message.type === "synthetic" || message.type === "system") {
    return {
      info: userMessageFromPrompt({
        sessionID,
        messageID: message.id,
        text: message.text,
        timestamp: created,
        meta,
      }),
      parts: [
        userTextPart({
          sessionID,
          messageID: message.id,
          text: message.text,
          synthetic: message.type === "synthetic",
        }),
      ],
    }
  }

  // session.shell / Shell message → bash tool row (matches projector.ts shell branch)
  if (message.type === "shell") {
    const completed = message.time.completed === undefined ? undefined : ts(message.time.completed)
    const end = completed ?? created
    const output = message.output ?? ""
    const exit = "exit" in message ? message.exit : undefined
    const failed = typeof exit === "number" && exit !== 0
    const body = ["$ " + message.command, output].filter(Boolean).join("\n")
    const info = assistantMessageFromStep({
      sessionID,
      messageID: message.id,
      agent: meta.agent,
      model: { id: meta.model.modelID, providerID: meta.model.providerID, variant: meta.model.variant },
      timestamp: created,
      parentID: parentID ?? message.id,
      directory: meta.directory,
    })
    info.time = { created, completed: end }
    info.finish = failed ? "error" : "stop"
    const parts: Part[] = [
      {
        id: `prt_${message.id}_shell`,
        sessionID,
        messageID: message.id,
        type: "tool" as const,
        tool: "bash",
        callID: message.callID,
        state: failed
          ? {
              status: "error" as const,
              input: { command: message.command },
              error: `exit ${exit}`,
              metadata: {
                output,
                ...(exit === undefined ? {} : { exit }),
              },
              time: { start: created, end },
            }
          : {
              status: "completed" as const,
              input: { command: message.command },
              output,
              title: "bash",
              metadata: {
                output,
                ...(exit === undefined ? {} : { exit }),
              },
              time: { start: created, end },
            },
      },
      {
        id: `prt_${message.id}_text`,
        sessionID,
        messageID: message.id,
        type: "text" as const,
        text: body,
        time: { start: created, end },
      },
    ]
    return { info, parts }
  }

  if (message.type === "compaction") {
    return {
      info: userMessageFromPrompt({
        sessionID,
        messageID: message.id,
        text: message.summary,
        timestamp: created,
        meta,
      }),
      parts: [
        userTextPart({
          sessionID,
          messageID: message.id,
          text: message.summary,
        }),
        {
          id: `prt_${message.id}_compaction`,
          sessionID,
          messageID: message.id,
          type: "compaction" as const,
          auto: message.reason === "auto",
        },
      ],
    }
  }

  if (message.type === "assistant") {
    const tokens = message.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const completed = message.time.completed === undefined ? undefined : ts(message.time.completed)
    const firstRaw = (message.time as { first?: unknown }).first
    const first = firstRaw === undefined ? undefined : ts(firstRaw)
    const info: AssistantMessage = {
      id: message.id,
      sessionID,
      role: "assistant",
      parentID: parentID ?? message.id,
      agent: message.agent || meta.agent,
      mode: message.agent || meta.agent,
      modelID: message.model.id,
      providerID: message.model.providerID,
      path: { cwd: meta.directory, root: meta.directory },
      cost: message.cost ?? 0,
      tokens: {
        total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: tokens.cache,
      },
      time: {
        created,
        ...(first === undefined || first <= created ? {} : { first }),
        ...(completed === undefined ? {} : { completed }),
      } as AssistantMessage["time"],
      ...(message.finish === undefined ? {} : { finish: message.finish }),
      ...(message.model.variant === undefined ? {} : { variant: message.model.variant }),
      ...(message.error === undefined
        ? {}
        : { error: { name: "UnknownError", data: { message: message.error.message ?? "error" } } }),
    }

    const parts: Part[] = message.content.map((part): Part => {
      if (part.type === "text") {
        return {
          id: textPartID(message.id, part.id),
          sessionID,
          messageID: message.id,
          type: "text" as const,
          text: part.text,
          // Assistant text has no per-part clock; anchor to message created for order.
          time: { start: created, ...(completed === undefined ? {} : { end: completed }) },
        }
      }
      if (part.type === "reasoning") {
        const start = part.time?.created === undefined ? undefined : ts(part.time.created)
        const end = part.time?.completed === undefined ? undefined : ts(part.time.completed)
        return {
          id: reasoningPartID(message.id, part.id),
          sessionID,
          messageID: message.id,
          type: "reasoning" as const,
          text: part.text,
          time: {
            start: start ?? end ?? ts(undefined),
            ...(end === undefined ? {} : { end }),
          },
        }
      }
      const start = ts(part.time.created)
      const end = ts(part.time.completed ?? part.time.created)
      const state = part.state
      // Pending tools carry input as a raw JSON string; keep a usable object for
      // the V1 tool UI instead of dropping it to {}.
      const input =
        typeof state.input === "string"
          ? state.input.length > 0
            ? { value: state.input }
            : {}
          : (state.input ?? {})
      if (state.status === "completed") {
        const output = toolOutputText(state.content as Array<{ type?: string; text?: string }>)
        const structured =
          state.structured && typeof state.structured === "object"
            ? (state.structured as Record<string, unknown>)
            : {}
        // session-display shell reads metadata.output; keep state.output for generic/task/web.
        return {
          id: toolPartID(message.id, part.id),
          sessionID,
          messageID: message.id,
          type: "tool" as const,
          tool: part.name,
          callID: part.id,
          state: {
            status: "completed" as const,
            input,
            output,
            title: part.name,
            metadata: {
              ...structured,
              output,
            },
            time: { start, end },
          },
        }
      }
      if (state.status === "error") {
        const output = toolOutputText(state.content as Array<{ type?: string; text?: string }>)
        const structured =
          state.structured && typeof state.structured === "object"
            ? (state.structured as Record<string, unknown>)
            : {}
        return {
          id: toolPartID(message.id, part.id),
          sessionID,
          messageID: message.id,
          type: "tool" as const,
          tool: part.name,
          callID: part.id,
          state: {
            status: "error" as const,
            input,
            error: state.error?.message ?? "tool error",
            metadata: {
              ...structured,
              ...(output ? { output } : {}),
            },
            time: { start, end },
          },
        }
      }
      return {
        id: toolPartID(message.id, part.id),
        sessionID,
        messageID: message.id,
        type: "tool" as const,
        tool: part.name,
        callID: part.id,
        state: {
          status: "running" as const,
          input,
          time: { start },
        },
      }
    })

    return { info, parts }
  }

  return undefined
}
