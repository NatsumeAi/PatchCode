import { describe, expect, test } from "bun:test"
import { projectParentTrace } from "../src/session/fork-mode"
import { SessionMessage } from "@opencode-ai/core/session/message"

const user = (text: string): SessionMessage.Message =>
  ({ id: "msg_u", sessionID: "ses_1", type: "user", text } as unknown as SessionMessage.Message)

const assistant = (content: readonly SessionMessage.AssistantContent[]): SessionMessage.Message =>
  ({
    id: "msg_a",
    sessionID: "ses_1",
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    content,
    time: { created: 1_700_000_000_000, completed: 1_700_000_001_000 },
  }) as unknown as SessionMessage.Message

const text = (value: string): SessionMessage.AssistantContent[] =>
  [{ type: "text" as const, id: "txt_1", text: value }]

const tool = (name: string, output: string): SessionMessage.AssistantContent[] =>
  [
    {
      type: "tool",
      id: "tool_1",
      name,
      state: {
        status: "completed",
        content: [{ type: "text", text: output }],
        input: {},
      },
    },
  ] as unknown as SessionMessage.AssistantContent[]

describe("projectParentTrace", () => {
  const messages = [
    user("first question"),
    assistant([...text("first answer"), ...tool("bash", "done")]),
    user("second question"),
    assistant(text("second answer")),
  ]

  test("PromptOnly produces empty trace", () => {
    expect(projectParentTrace(messages, "PromptOnly")).toBe("")
  })

  test("FullHistory includes all user and assistant text", () => {
    const trace = projectParentTrace(messages, "FullHistory")
    expect(trace).toContain("first question")
    expect(trace).toContain("first answer")
    expect(trace).toContain("second question")
    expect(trace).toContain("second answer")
  })

  test("ForkMode parent trace is the child first user", () => {
    const trace = projectParentTrace(messages, "FullHistory")
    expect(trace.startsWith("user: first question")).toBe(true)
  })

  test("FullHistory includes tool calls with result summaries", () => {
    const trace = projectParentTrace(messages, "FullHistory")
    expect(trace).toContain("tool: bash -> done")
  })

  test("LastNTurns keeps only the last 50 messages", () => {
    const many: SessionMessage.Message[] = []
    for (let i = 0; i < 60; i++) {
      many.push(user(`msg-${i}`))
      many.push(assistant(text(`answer-${i}`)))
    }
    const trace = projectParentTrace(many, "LastNTurns")
    expect(trace).toContain("msg-59")
    expect(trace).not.toContain("msg-0")
    expect(trace).not.toContain("msg-8")
  })

  test("drops reasoning parts", () => {
    const withReasoning: SessionMessage.Message[] = [
      assistant([
        ...text("answer"),
        { type: "reasoning" as const, id: "r1", text: "secret thinking" },
      ]),
    ]
    const trace = projectParentTrace(withReasoning, "FullHistory")
    expect(trace).toContain("answer")
    expect(trace).not.toContain("secret thinking")
  })

  test("caps tool result output", () => {
    const bigOutput = "x".repeat(1000)
    const trace = projectParentTrace([assistant(tool("read", bigOutput))], "FullHistory")
    expect(trace.length).toBeLessThan(600)
  })
})
