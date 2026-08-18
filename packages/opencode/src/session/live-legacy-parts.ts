// Map live session.next.* SSE events onto leftover Message+Part shapes so
// official CLI / ACP consumers that still read message.part.updated can paint
// the unique live drain without a second durable leftover event stream.
import type { Event, Part, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/api"

export type LivePartState = {
  readonly tools: Map<string, { tool: string; input: Record<string, unknown>; start: number }>
  readonly texts: Map<string, { text: string; start: number }>
  readonly reasonings: Map<string, { text: string; start: number }>
}

export function createLivePartState(): LivePartState {
  return { tools: new Map(), texts: new Map(), reasonings: new Map() }
}

/** Session ID on live `session.next.*` events, including text/tool/permission-adjacent traffic. */
export function liveSessionID(event: Event): string | undefined {
  if (!event.type.startsWith("session.next.")) return undefined
  const id = Reflect.get(event.properties, "sessionID")
  return typeof id === "string" ? id : undefined
}

function streamKey(messageID: string, partID: string) {
  return `${messageID}:${partID}`
}

function textPartID(messageID: string, textID: string) {
  return `prt_${messageID}_${textID}`
}

function reasoningPartID(messageID: string, reasoningID: string) {
  return `prt_${messageID}_${reasoningID}`
}

function toolPartID(messageID: string, callID: string) {
  return `prt_${messageID}_${callID}`
}

function toolOutput(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .map((item) => (item && typeof item === "object" && "type" in item && item.type === "text" && "text" in item ? String(item.text ?? "") : ""))
    .filter(Boolean)
    .join("\n")
}

function rememberTool(
  state: LivePartState,
  callID: string,
  patch: { tool?: string; input?: Record<string, unknown>; start?: number },
) {
  const current = state.tools.get(callID)
  state.tools.set(callID, {
    tool: patch.tool || current?.tool || "tool",
    input: patch.input ?? current?.input ?? {},
    start: patch.start ?? current?.start ?? Date.now(),
  })
}

function runningToolPart(
  properties: { sessionID: string; assistantMessageID: string; callID: string; timestamp?: number },
  state: LivePartState,
  output?: string,
): ToolPart {
  const remembered = state.tools.get(properties.callID)
  return {
    id: toolPartID(properties.assistantMessageID, properties.callID),
    sessionID: properties.sessionID,
    messageID: properties.assistantMessageID,
    type: "tool",
    callID: properties.callID,
    tool: remembered?.tool ?? "tool",
    state: {
      status: "running",
      input: remembered?.input ?? {},
      title: remembered?.tool ?? "tool",
      time: { start: remembered?.start ?? properties.timestamp ?? Date.now() },
      ...(output !== undefined ? { metadata: { output } } : {}),
    },
  }
}

export function leftoverPartsFromLive(event: Event, state: LivePartState): Part[] {
  switch (event.type) {
    case "session.next.step.started":
      return [
        {
          id: `prt_${event.properties.assistantMessageID}_step_start`,
          sessionID: event.properties.sessionID,
          messageID: event.properties.assistantMessageID,
          type: "step-start",
          ...(event.properties.snapshot ? { snapshot: event.properties.snapshot } : {}),
        },
      ]
    case "session.next.step.ended":
      return [
        {
          id: `prt_${event.properties.assistantMessageID}_step_finish`,
          sessionID: event.properties.sessionID,
          messageID: event.properties.assistantMessageID,
          type: "step-finish",
          reason: event.properties.finish,
          cost: event.properties.cost,
          tokens: event.properties.tokens,
          ...(event.properties.snapshot ? { snapshot: event.properties.snapshot } : {}),
        },
      ]
    case "session.next.step.failed":
      return [
        {
          id: `prt_${event.properties.assistantMessageID}_step_finish`,
          sessionID: event.properties.sessionID,
          messageID: event.properties.assistantMessageID,
          type: "step-finish",
          reason: "unknown",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ]
    case "session.next.text.started": {
      state.texts.set(streamKey(event.properties.assistantMessageID, event.properties.textID), {
        text: "",
        start: event.properties.timestamp,
      })
      return []
    }
    case "session.next.text.delta": {
      const key = streamKey(event.properties.assistantMessageID, event.properties.textID)
      const current = state.texts.get(key)
      const start = current?.start ?? event.properties.timestamp
      const text = (current?.text ?? "") + event.properties.delta
      state.texts.set(key, { text, start })
      const part: TextPart = {
        id: textPartID(event.properties.assistantMessageID, event.properties.textID),
        sessionID: event.properties.sessionID,
        messageID: event.properties.assistantMessageID,
        type: "text",
        text,
        time: { start },
      }
      return [part]
    }
    case "session.next.text.ended": {
      const key = streamKey(event.properties.assistantMessageID, event.properties.textID)
      const current = state.texts.get(key)
      state.texts.delete(key)
      const end = event.properties.timestamp
      const part: TextPart = {
        id: textPartID(event.properties.assistantMessageID, event.properties.textID),
        sessionID: event.properties.sessionID,
        messageID: event.properties.assistantMessageID,
        type: "text",
        text: event.properties.text,
        time: { start: current?.start ?? end, end },
      }
      return [part]
    }
    case "session.next.reasoning.started": {
      state.reasonings.set(streamKey(event.properties.assistantMessageID, event.properties.reasoningID), {
        text: "",
        start: event.properties.timestamp,
      })
      return []
    }
    case "session.next.reasoning.delta": {
      const key = streamKey(event.properties.assistantMessageID, event.properties.reasoningID)
      const current = state.reasonings.get(key)
      const start = current?.start ?? event.properties.timestamp
      const text = (current?.text ?? "") + event.properties.delta
      state.reasonings.set(key, { text, start })
      const part: ReasoningPart = {
        id: reasoningPartID(event.properties.assistantMessageID, event.properties.reasoningID),
        sessionID: event.properties.sessionID,
        messageID: event.properties.assistantMessageID,
        type: "reasoning",
        text,
        time: { start },
      }
      return [part]
    }
    case "session.next.reasoning.ended": {
      const key = streamKey(event.properties.assistantMessageID, event.properties.reasoningID)
      const current = state.reasonings.get(key)
      state.reasonings.delete(key)
      const end = event.properties.timestamp
      const part: ReasoningPart = {
        id: reasoningPartID(event.properties.assistantMessageID, event.properties.reasoningID),
        sessionID: event.properties.sessionID,
        messageID: event.properties.assistantMessageID,
        type: "reasoning",
        text: event.properties.text,
        time: { start: current?.start ?? end, end },
      }
      return [part]
    }
    case "session.next.tool.input.started":
      rememberTool(state, event.properties.callID, {
        tool: event.properties.name,
        start: event.properties.timestamp,
      })
      return []
    case "session.next.tool.called":
      rememberTool(state, event.properties.callID, {
        tool: event.properties.tool,
        input: event.properties.input,
        start: event.properties.timestamp,
      })
      return [runningToolPart(event.properties, state)]
    case "session.next.tool.progress": {
      const output = toolOutput(event.properties.content)
      return [runningToolPart(event.properties, state, output)]
    }
    case "session.next.tool.success": {
      const remembered = state.tools.get(event.properties.callID)
      const output = toolOutput(event.properties.content)
      const structured =
        event.properties.structured && typeof event.properties.structured === "object" ? event.properties.structured : {}
      const start = remembered?.start ?? event.properties.timestamp
      const part: ToolPart = {
        id: toolPartID(event.properties.assistantMessageID, event.properties.callID),
        sessionID: event.properties.sessionID,
        messageID: event.properties.assistantMessageID,
        type: "tool",
        callID: event.properties.callID,
        tool: remembered?.tool ?? "tool",
        state: {
          status: "completed",
          input: remembered?.input ?? {},
          output,
          title: remembered?.tool ?? "tool",
          metadata: { ...structured, output },
          time: { start, end: event.properties.timestamp },
        },
      }
      return [part]
    }
    case "session.next.tool.failed": {
      const remembered = state.tools.get(event.properties.callID)
      const start = remembered?.start ?? event.properties.timestamp
      const error =
        event.properties.error && typeof event.properties.error === "object" && "message" in event.properties.error
          ? String(event.properties.error.message)
          : "tool failed"
      const part: ToolPart = {
        id: toolPartID(event.properties.assistantMessageID, event.properties.callID),
        sessionID: event.properties.sessionID,
        messageID: event.properties.assistantMessageID,
        type: "tool",
        callID: event.properties.callID,
        tool: remembered?.tool ?? "tool",
        state: {
          status: "error",
          input: remembered?.input ?? {},
          error,
          time: { start, end: event.properties.timestamp },
        },
      }
      return [part]
    }
    default:
      return []
  }
}
