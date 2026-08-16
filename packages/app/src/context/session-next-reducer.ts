import type { SessionMessageInfo, SessionPendingMessage } from "@opencode-ai/client/promise"

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>
type Compaction = Extract<SessionMessageInfo, { type: "compaction" }>
type Shell = Extract<SessionMessageInfo, { type: "shell" }>

/**
 * Loose shape for live `session.next.*` events. The generated OpenCodeEvent
 * union predates the V2 session event surface, so the reducer narrows by its
 * own switch instead of relying on the client type.
 */
export type V2SessionEvent = {
  readonly id: string
  readonly type: string
  readonly data: Record<string, any>
  readonly metadata?: Record<string, unknown>
}

export type V2SessionReduction = {
  sessionID: string
  messages: SessionMessageInfo[]
  touched: string[]
  missing?: string
}

const created = (event: V2SessionEvent): number =>
  typeof event.data.timestamp === "number" ? event.data.timestamp : Date.now()

export function createV2SessionReducer() {
  const pending = new Map<string, SessionPendingMessage>()

  const reduce = (source: readonly SessionMessageInfo[], event: V2SessionEvent): V2SessionReduction | undefined => {
    if (!("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
    const sessionID = event.data.sessionID
    const result = (messages: SessionMessageInfo[], touched: string[] = []): V2SessionReduction => ({
      sessionID,
      messages,
      touched,
    })
    const append = (message: SessionMessageInfo) =>
      result(source.some((item) => item.id === message.id) ? [...source] : [...source, message], [message.id])

    switch (event.type) {
      case "session.next.prompt.admitted":
        pending.set(key(sessionID, event.data.messageID), event.data.prompt)
        return result([...source])
      case "session.next.prompted": {
        pending.delete(key(sessionID, event.data.messageID))
        return append({
          id: event.data.messageID,
          type: "user",
          text: event.data.prompt.text,
          files: event.data.prompt.files,
          agents: event.data.prompt.agents,
          time: { created: created(event) },
        })
      }
      case "session.next.agent.switched":
        return append({
          id: messageID(event.id),
          type: "agent-switched",
          agent: event.data.agent,
          time: { created: created(event) },
        })
      case "session.next.model.switched":
        return append({
          id: messageID(event.id),
          type: "model-switched",
          model: event.data.model,
          previous: source.findLast(
            (item): item is Extract<SessionMessageInfo, { type: "model-switched" | "assistant" }> =>
              item.type === "model-switched" || item.type === "assistant",
          )?.model,
          time: { created: created(event) },
        })
      case "session.next.synthetic":
        return append({
          id: event.data.messageID,
          type: "synthetic",
          text: event.data.text,
          time: { created: created(event) },
        })
      case "session.next.shell.started":
        return append({
          id: messageID(event.id),
          type: "shell",
          shellID: event.data.callID,
          command: event.data.command,
          status: "running",
          time: { created: created(event) },
        })
      case "session.next.shell.ended":
        return updateMessage<Shell>(
          source,
          (item): item is Shell => item.type === "shell" && item.shellID === event.data.callID,
          (item) => ({
            ...item,
            output: event.data.output,
            time: { ...item.time, completed: created(event) },
          }),
          sessionID,
        )
      case "session.next.step.started": {
        const current = source.findLast((item): item is Assistant => item.type === "assistant" && !item.time.completed)
        const completed =
          current && current.id !== event.data.assistantMessageID
            ? update(source, current.id, (item) =>
                item.type === "assistant"
                  ? { ...item, retry: undefined, time: { ...item.time, completed: created(event) } }
                  : item,
              )
            : [...source]
        const existing = completed.find((item) => item.id === event.data.assistantMessageID)
        if (existing?.type === "assistant")
          return result(
            update(completed, existing.id, (item) =>
              item.type === "assistant"
                ? {
                    ...item,
                    agent: event.data.agent,
                    model: event.data.model,
                    retry: undefined,
                    error: undefined,
                    finish: undefined,
                    snapshot: event.data.snapshot ? { ...item.snapshot, start: event.data.snapshot } : item.snapshot,
                    time: { ...item.time, completed: undefined },
                  }
                : item,
            ),
            current && current.id !== existing.id ? [current.id, existing.id] : [existing.id],
          )
        return result(
          [
            ...completed,
            {
              id: event.data.assistantMessageID,
              type: "assistant",
              agent: event.data.agent,
              model: event.data.model,
              content: [],
              snapshot: event.data.snapshot ? { start: event.data.snapshot } : undefined,
              time: { created: created(event) },
            },
          ],
          current ? [current.id, event.data.assistantMessageID] : [event.data.assistantMessageID],
        )
      }
      case "session.next.step.ended":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          finish: event.data.finish,
          cost: event.data.cost,
          tokens: event.data.tokens,
          snapshot:
            event.data.snapshot || event.data.files
              ? { ...item.snapshot, end: event.data.snapshot, files: event.data.files }
              : item.snapshot,
          time: { ...item.time, completed: created(event) },
        }))
      case "session.next.step.failed":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          finish: "error",
          error: event.data.error,
          retry: undefined,
          time: { ...item.time, completed: created(event) },
        }))
      case "session.next.text.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: item.content.some(
            (content) => content.type === "text" && (content as { id?: string }).id === event.data.textID,
          )
            ? item.content
            : [...item.content, { type: "text", id: event.data.textID, text: "" } as Assistant["content"][number]],
        }))
      case "session.next.text.delta":
        return updateContent(source, event.data.assistantMessageID, sessionID, "text", event.data.textID, (item) => ({
          ...item,
          text: item.text + event.data.delta,
        }))
      case "session.next.text.ended":
        return updateContent(source, event.data.assistantMessageID, sessionID, "text", event.data.textID, (item) => ({
          ...item,
          text: event.data.text,
        }))
      case "session.next.reasoning.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: item.content.some(
            (content) =>
              content.type === "reasoning" && (content as { id?: string }).id === event.data.reasoningID,
          )
            ? item.content
            : [
                ...item.content,
                {
                  type: "reasoning",
                  id: event.data.reasoningID,
                  text: "",
                  time: { created: created(event) },
                } as Assistant["content"][number],
              ],
        }))
      case "session.next.reasoning.delta":
        return updateContent(
          source,
          event.data.assistantMessageID,
          sessionID,
          "reasoning",
          event.data.reasoningID,
          (item) => ({
            ...item,
            text: item.text + event.data.delta,
          }),
        )
      case "session.next.reasoning.ended":
        return updateContent(
          source,
          event.data.assistantMessageID,
          sessionID,
          "reasoning",
          event.data.reasoningID,
          (item) => ({
            ...item,
            text: event.data.text,
            time: { created: item.time?.created ?? created(event), completed: created(event) },
          }),
        )
      case "session.next.tool.input.started":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          content: item.content.some((content) => content.type === "tool" && content.id === event.data.callID)
            ? item.content
            : [
                ...item.content,
                {
                  type: "tool",
                  id: event.data.callID,
                  name: event.data.name,
                  state: { status: "streaming", input: "" },
                  time: { created: created(event) },
                } as Assistant["content"][number],
              ],
        }))
      case "session.next.tool.input.delta":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) =>
          tool.state.status === "streaming"
            ? { ...tool, state: { ...tool.state, input: tool.state.input + event.data.delta } }
            : tool,
        )
      case "session.next.tool.input.ended":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) =>
          tool.state.status === "streaming" ? { ...tool, state: { ...tool.state, input: event.data.text } } : tool,
        )
      case "session.next.tool.called":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) => ({
          ...tool,
          executed: event.data.provider.executed,
          providerState: event.data.provider.metadata,
          state: { status: "running", input: event.data.input, metadata: {} },
          time: { ...tool.time, ran: created(event) },
        }))
      case "session.next.tool.progress":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) =>
          tool.state.status === "running"
            ? { ...tool, state: { ...tool.state, structured: event.data.structured, content: event.data.content } }
            : tool,
        )
      case "session.next.tool.success":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) => {
          if (tool.state.status !== "running") return tool
          return {
            ...tool,
            executed: event.data.provider.executed || tool.executed === true,
            providerResultState: event.data.provider.metadata,
            state: {
              status: "completed",
              input: tool.state.input,
              structured: event.data.structured,
              metadata: event.data.provider.metadata,
              content: event.data.content,
              result: event.data.result,
            },
            time: { ...tool.time, completed: created(event) },
          }
        })
      case "session.next.tool.failed":
        return updateTool(source, event.data.assistantMessageID, event.data.callID, sessionID, (tool) => {
          if (tool.state.status !== "streaming" && tool.state.status !== "running") return tool
          return {
            ...tool,
            executed: event.data.provider.executed || tool.executed === true,
            providerResultState: event.data.provider.metadata,
            state: {
              status: "error",
              input: typeof tool.state.input === "string" ? {} : tool.state.input,
              content: event.data.content,
              error: event.data.error,
              result: event.data.result,
            },
            time: { ...tool.time, completed: created(event) },
          }
        })
      case "session.next.retried":
        return updateAssistant(source, event.data.assistantMessageID, sessionID, (item) => ({
          ...item,
          retry: { attempt: event.data.attempt, at: created(event), error: event.data.error },
        }))
      case "session.next.compaction.started":
        return append({
          id: event.data.messageID,
          type: "compaction",
          status: "running",
          reason: event.data.reason,
          summary: "",
          recent: "",
          time: { created: created(event) },
        })
      case "session.next.compaction.delta":
        return updateMessage<Extract<Compaction, { status: "running" }>>(
          source,
          (item): item is Extract<Compaction, { status: "running" }> =>
            item.type === "compaction" && item.status === "running",
          (item) => ({
            ...item,
            summary: item.summary + event.data.text,
          }),
          sessionID,
        )
      case "session.next.compaction.ended": {
        const current = source.findLast(
          (item): item is Extract<Compaction, { status: "running" }> =>
            item.type === "compaction" && item.status === "running",
        )
        if (!current)
          return append({
            id: event.data.messageID,
            type: "compaction",
            status: "completed",
            reason: event.data.reason,
            summary: event.data.text,
            recent: "",
            time: { created: created(event) },
          })
        return result(
          update(source, current.id, () => ({
            ...current,
            status: "completed",
            reason: event.data.reason,
            summary: event.data.text,
          })),
          [current.id],
        )
      }
      default:
        return
    }
  }

  return {
    reduce,
    clear(sessionID: string) {
      for (const id of pending.keys()) {
        if (id.startsWith(`${sessionID}:`)) pending.delete(id)
      }
    },
  }
}

function key(sessionID: string, messageID: string) {
  return `${sessionID}:${messageID}`
}

function messageID(eventID: string) {
  return eventID.replace(/^evt_/, "msg_")
}

function update(
  source: readonly SessionMessageInfo[],
  id: string,
  apply: (item: SessionMessageInfo) => SessionMessageInfo,
) {
  return source.map((item) => (item.id === id ? apply(item) : item))
}

function updateMessage<T extends SessionMessageInfo>(
  source: readonly SessionMessageInfo[],
  matches: (item: SessionMessageInfo) => item is T,
  apply: (item: T) => T,
  sessionID: string,
): V2SessionReduction {
  const current = source.findLast(matches)
  if (!current) return { sessionID, messages: [...source], touched: [] }
  return {
    sessionID,
    messages: update(source, current.id, (item) => (matches(item) ? apply(item) : item)),
    touched: [current.id],
  }
}

function updateAssistant(
  source: readonly SessionMessageInfo[],
  id: string,
  sessionID: string,
  apply: (item: Assistant) => Assistant,
): V2SessionReduction {
  return {
    sessionID,
    messages: update(source, id, (item) => (item.type === "assistant" ? apply(item) : item)),
    touched: source.some((item) => item.id === id && item.type === "assistant") ? [id] : [],
  }
}

function updateContent<T extends "text" | "reasoning">(
  source: readonly SessionMessageInfo[],
  messageID: string,
  sessionID: string,
  type: T,
  partID: string,
  apply: (
    item: Extract<Assistant["content"][number], { type: T }>,
  ) => Extract<Assistant["content"][number], { type: T }>,
) {
  return updateAssistant(source, messageID, sessionID, (assistant) => ({
    ...assistant,
    content: assistant.content.map((item) =>
      item.type === type && (item as { id?: string }).id === partID
        ? apply(item as Extract<Assistant["content"][number], { type: T }>)
        : item,
    ),
  }))
}

function updateTool(
  source: readonly SessionMessageInfo[],
  messageID: string,
  callID: string,
  sessionID: string,
  apply: (
    item: Extract<Assistant["content"][number], { type: "tool" }>,
  ) => Extract<Assistant["content"][number], { type: "tool" }>,
) {
  return updateAssistant(source, messageID, sessionID, (assistant) => ({
    ...assistant,
    content: assistant.content.map((item) => (item.type === "tool" && item.id === callID ? apply(item) : item)),
  }))
}
