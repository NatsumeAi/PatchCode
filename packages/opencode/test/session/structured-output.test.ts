import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/session-legacy"
import { Exit, Schema } from "effect"
import { MessageV2 } from "../../src/session/session-message-wire"
import { SessionID, MessageID } from "../../src/session/schema"

const decodeFormat = Schema.decodeUnknownExit(SessionV1.Format)
const decodeUser = Schema.decodeUnknownExit(SessionV1.User)
const decodeAssistant = Schema.decodeUnknownExit(SessionV1.Assistant)

describe("structured-output.OutputFormat", () => {
  test("parses text format", () => {
    const result = decodeFormat({ type: "text" })
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) {
      expect(result.value.type).toBe("text")
    }
  })

  test("parses json_schema format with defaults", () => {
    const result = decodeFormat({
      type: "json_schema",
      schema: { type: "object", properties: { name: { type: "string" } } },
    })
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) {
      expect(result.value.type).toBe("json_schema")
      if (result.value.type === "json_schema") {
        expect(result.value.retryCount).toBe(2) // default value
      }
    }
  })

  test("parses json_schema format with custom retryCount", () => {
    const result = decodeFormat({
      type: "json_schema",
      schema: { type: "object" },
      retryCount: 5,
    })
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result) && result.value.type === "json_schema") {
      expect(result.value.retryCount).toBe(5)
    }
  })

  test("rejects invalid type", () => {
    const result = decodeFormat({ type: "invalid" })
    expect(Exit.isFailure(result)).toBe(true)
  })

  test("rejects json_schema without schema", () => {
    const result = decodeFormat({ type: "json_schema" })
    expect(Exit.isFailure(result)).toBe(true)
  })

  test("rejects negative retryCount", () => {
    const result = decodeFormat({
      type: "json_schema",
      schema: { type: "object" },
      retryCount: -1,
    })
    expect(Exit.isFailure(result)).toBe(true)
  })
})

describe("structured-output.StructuredOutputError", () => {
  test("creates error with message and retries", () => {
    const error = new SessionV1.StructuredOutputError({
      message: "Failed to validate",
      retries: 3,
    })

    expect(error.name).toBe("StructuredOutputError")
    expect(error.data.message).toBe("Failed to validate")
    expect(error.data.retries).toBe(3)
  })

  test("converts to object correctly", () => {
    const error = new SessionV1.StructuredOutputError({
      message: "Test error",
      retries: 2,
    })

    const obj = error.toObject()
    expect(obj.name).toBe("StructuredOutputError")
    expect(obj.data.message).toBe("Test error")
    expect(obj.data.retries).toBe(2)
  })

  test("isInstance correctly identifies error", () => {
    const error = new SessionV1.StructuredOutputError({
      message: "Test",
      retries: 1,
    })

    expect(SessionV1.StructuredOutputError.isInstance(error)).toBe(true)
    expect(SessionV1.StructuredOutputError.isInstance({ name: "other" })).toBe(false)
  })
})

describe("structured-output.UserMessage", () => {
  test("user message accepts outputFormat", () => {
    const result = decodeUser({
      id: MessageID.ascending(),
      sessionID: SessionID.descending(),
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: { providerID: "anthropic", modelID: "claude-3" },
      outputFormat: {
        type: "json_schema",
        schema: { type: "object" },
      },
    })
    expect(Exit.isSuccess(result)).toBe(true)
  })

  test("user message works without outputFormat (optional)", () => {
    const result = decodeUser({
      id: MessageID.ascending(),
      sessionID: SessionID.descending(),
      role: "user",
      time: { created: Date.now() },
      agent: "default",
      model: { providerID: "anthropic", modelID: "claude-3" },
    })
    expect(Exit.isSuccess(result)).toBe(true)
  })
})

describe("structured-output.AssistantMessage", () => {
  const baseAssistantMessage = {
    id: MessageID.ascending(),
    sessionID: SessionID.descending(),
    role: "assistant" as const,
    parentID: MessageID.ascending(),
    modelID: "claude-3",
    providerID: "anthropic",
    mode: "default",
    agent: "default",
    path: { cwd: "/test", root: "/test" },
    cost: 0.001,
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
  }

  test("assistant message accepts structured", () => {
    const result = decodeAssistant({
      ...baseAssistantMessage,
      structured: { company: "Anthropic", founded: 2021 },
    })
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) {
      expect(result.value.structured).toEqual({ company: "Anthropic", founded: 2021 })
    }
  })

  test("assistant message works without structured_output (optional)", () => {
    const result = decodeAssistant(baseAssistantMessage)
    expect(Exit.isSuccess(result)).toBe(true)
  })
})
