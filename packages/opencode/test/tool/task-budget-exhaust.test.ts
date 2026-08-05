import { describe, expect, test } from "bun:test"
import { detectBudgetExhausted, lastAssistantError } from "../../src/tool/tool-host-bridges"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"

const assistant = (content: readonly SessionMessage.AssistantContent[]): SessionMessage.Message =>
  ({
    id: "msg_1",
    sessionID: "ses_1",
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    content,
    time: { created: 1_700_000_000_000, completed: 1_700_000_001_000 },
  }) as unknown as SessionMessage.Message

const text = (value: string): SessionMessage.AssistantContent[] =>
  [{ type: "text" as const, id: "txt_1", text: value }]

describe("detectBudgetExhausted", () => {
  test("false when agent has no steps limit", () => {
    expect(
      detectBudgetExhausted({ agentSteps: undefined, messages: [assistant(text("hi"))] }),
    ).toBe(false)
  })

  test("false when assistant count is below steps", () => {
    const messages = [assistant(text("hi")), assistant(text("hi"))]
    expect(detectBudgetExhausted({ agentSteps: 5, messages })).toBe(false)
  })

  test("true when assistant count reaches steps and final message has no tool calls", () => {
    const messages = [
      assistant(text("a")),
      assistant(text("b")),
      assistant(text("MAX STEPS REACHED")),
    ]
    expect(detectBudgetExhausted({ agentSteps: 3, messages })).toBe(true)
  })

  test("false when final message at steps still made a tool call", () => {
    const messages = [
      assistant(text("a")),
      assistant([
        { type: "tool", callID: "call_1", tool: "bash", state: { status: "completed", input: {} } },
      ] as never),
    ]
    expect(detectBudgetExhausted({ agentSteps: 2, messages })).toBe(false)
  })

  test("false on empty messages", () => {
    expect(detectBudgetExhausted({ agentSteps: 3, messages: [] })).toBe(false)
  })
})

const erroredAssistant = (message: string): SessionMessage.Message =>
  ({
    id: "msg_err",
    sessionID: "ses_1",
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    content: [],
    time: { created: 1_700_000_000_000, completed: 1_700_000_001_000 },
    error: { type: "unknown", message },
  }) as unknown as SessionMessage.Message

describe("lastAssistantError", () => {
  test("undefined when the last assistant has no error", () => {
    expect(lastAssistantError([assistant(text("ok"))])).toBeUndefined()
  })

  test("undefined on empty messages", () => {
    expect(lastAssistantError([])).toBeUndefined()
  })

  test("returns the last assistant's error message", () => {
    expect(lastAssistantError([erroredAssistant("boom")])).toBe("boom")
  })

  test("later clean assistant clears an earlier error", () => {
    expect(lastAssistantError([erroredAssistant("boom"), assistant(text("recovered"))])).toBeUndefined()
  })

  test("reports the last assistant's error over a clean predecessor", () => {
    expect(lastAssistantError([assistant(text("a")), erroredAssistant("final")])).toBe("final")
  })
})
