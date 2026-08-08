import { expect, test } from "bun:test"
import { projectParentMessagesForInsert, projectParentTrace } from "../../src/session/fork-mode"
import type { SessionMessage } from "../../src/session/message"

const messages = [
  { type: "user", text: "fix the parser" },
  {
    type: "assistant",
    content: [
      { type: "text", text: "looking" },
      {
        type: "tool",
        name: "read",
        state: { status: "completed", content: [{ type: "text", text: "ok" }] },
      },
    ],
  },
] as unknown as SessionMessage.Message[]

test("projectParentMessagesForInsert wraps structured header", () => {
  const text = projectParentMessagesForInsert(messages, "FullHistory")
  expect(text.startsWith("Parent trace (structured)")).toBe(true)
  expect(text).toContain("user: fix the parser")
  expect(text).toContain("tool: read")
})

test("PromptOnly yields empty structured insert", () => {
  expect(projectParentMessagesForInsert(messages, "PromptOnly")).toBe("")
  expect(projectParentTrace(messages, "PromptOnly")).toBe("")
})
