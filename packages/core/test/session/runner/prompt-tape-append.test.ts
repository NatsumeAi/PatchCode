import { describe, expect, test } from "bun:test"
import * as Append from "@opencode-ai/core/session/runner/prompt-tape-append"

describe("prompt-tape-append", () => {
  test("system update is a new user message, never merged", () => {
    expect(Append.lowerSystemUpdate("AGENTS.md changed")).toEqual({
      role: "user",
      content: "<system-update>\nAGENTS.md changed\n</system-update>",
    })
  })

  test("assistant keeps the exact streamed arguments string", () => {
    const message = Append.lowerAssistantFromStream({
      text: null,
      toolCalls: [{ id: "c1", name: "echo", arguments: '{"zed":1,"alpha":2}' }],
    })
    expect(message).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"zed":1,"alpha":2}' } }],
    })
  })

  test("JSON.stringify of parsed input is not used", () => {
    const streamed = '{"zed": 1, "alpha": 2}'
    const message = Append.lowerAssistantFromStream({
      text: null,
      toolCalls: [{ id: "c1", name: "echo", arguments: streamed }],
    })
    expect(message.tool_calls![0]!.function.arguments).toBe(streamed)
    expect(message.tool_calls![0]!.function.arguments).not.toBe(JSON.stringify(JSON.parse(streamed)))
  })

  test("user inlines data URIs and does not rewrite them", () => {
    const message = Append.lowerUser({
      text: "see",
      files: [{ mime: "image/png", uri: "data:image/png;base64,aaa", name: "a.png" }],
    })
    expect(message.role).toBe("user")
    expect(JSON.stringify(message)).toContain("data:image/png;base64,aaa")
  })
})
