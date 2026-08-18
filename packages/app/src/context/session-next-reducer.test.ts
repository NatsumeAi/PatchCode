import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import { createSessionReducer, type SessionReduceEvent } from "./session-next-reducer"

const event = (input: object) => input as SessionReduceEvent
const ts = 1000
const base = { created: ts, location: { directory: "/repo" }, durable: { aggregateID: "ses_1", seq: 1, version: 1 } }

describe("current session reducer", () => {
  test("projects prompted input and streaming assistant content", () => {
    const reducer = createSessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
      return result
    }

    apply({
      ...base,
      id: "evt_prompted",
      type: "session.next.prompted",
      data: { sessionID: "ses_1", messageID: "msg_user", timestamp: ts, prompt: { text: "hello" } },
    })
    apply({
      ...base,
      id: "evt_step",
      type: "session.next.step.started",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        timestamp: ts,
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    apply({
      ...base,
      id: "evt_text_start",
      type: "session.next.text.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", timestamp: ts, textID: "t_0" },
    })
    apply({
      ...base,
      id: "evt_text_delta",
      type: "session.next.text.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", timestamp: ts, textID: "t_0", delta: "hel" },
    })
    apply({
      ...base,
      id: "evt_text_end",
      type: "session.next.text.ended",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", timestamp: ts, textID: "t_0", text: "hello" },
    })

    expect(messages[0]).toMatchObject({ id: "msg_user", type: "user", text: "hello" })
    expect(messages[1]).toMatchObject({
      id: "msg_assistant",
      type: "assistant",
      content: [{ type: "text", id: "t_0", text: "hello" }],
    })
  })

  test("folds tool, retry, and completion events", () => {
    const reducer = createSessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
    }

    apply({
      ...base,
      id: "evt_step",
      type: "session.next.step.started",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        timestamp: ts,
        agent: "build",
        model: { id: "model", providerID: "provider" },
      },
    })
    apply({
      ...base,
      id: "evt_tool_start",
      type: "session.next.tool.input.started",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", timestamp: ts, callID: "call_1", name: "bash" },
    })
    apply({
      ...base,
      id: "evt_tool_delta",
      type: "session.next.tool.input.delta",
      data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", timestamp: ts, callID: "call_1", delta: "{}" },
    })
    apply({
      ...base,
      id: "evt_tool_called",
      type: "session.next.tool.called",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        timestamp: ts,
        callID: "call_1",
        tool: "bash",
        input: {},
        provider: { executed: true },
      },
    })
    apply({
      ...base,
      id: "evt_tool_success",
      type: "session.next.tool.success",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        timestamp: ts,
        callID: "call_1",
        content: [{ type: "text", text: "done" }],
        provider: { executed: true },
      },
    })
    apply({
      ...base,
      id: "evt_retry",
      type: "session.next.retried",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        timestamp: ts,
        attempt: 2,
        error: { type: "unknown", message: "retry" },
      },
    })
    apply({
      ...base,
      id: "evt_ended",
      type: "session.next.step.ended",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_assistant",
        timestamp: ts,
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })

    expect(messages[0]).toMatchObject({
      type: "assistant",
      content: [{ type: "tool", id: "call_1", state: { status: "completed", content: [{ text: "done" }] } }],
      finish: "stop",
    })
  })

  test("projects prompted user message with files", () => {
    const reducer = createSessionReducer()
    const result = reducer.reduce(
      [],
      event({
        ...base,
        id: "evt_prompted",
        type: "session.next.prompted",
        data: {
          sessionID: "ses_1",
          messageID: "msg_user",
          timestamp: ts,
          prompt: { text: "look", files: [{ uri: "file:///a.png", mime: "image/png", name: "a.png" }] },
        },
      }),
    )

    expect(result).toMatchObject({
      sessionID: "ses_1",
      touched: ["msg_user"],
      messages: [
        {
          id: "msg_user",
          type: "user",
          text: "look",
          files: [{ uri: "file:///a.png", mime: "image/png", name: "a.png" }],
        },
      ],
    })
  })

  test("compaction started and ended fold into one checkpoint", () => {
    const reducer = createSessionReducer()
    let messages: SessionMessageInfo[] = []
    const apply = (input: object) => {
      const result = reducer.reduce(messages, event(input))
      if (result) messages = result.messages
    }

    apply({
      ...base,
      id: "evt_c_start",
      type: "session.next.compaction.started",
      data: { sessionID: "ses_1", messageID: "msg_compact", timestamp: ts, reason: "manual" },
    })
    apply({
      ...base,
      id: "evt_c_end",
      type: "session.next.compaction.ended",
      data: { sessionID: "ses_1", messageID: "msg_compact", timestamp: ts, reason: "manual", text: "summary" },
    })

    expect(messages[0]).toMatchObject({
      id: "msg_compact",
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "summary",
    })
  })
})
