import { describe, expect, test } from "bun:test"
import { LLMEvent } from "@opencode-ai/llm"
import { RepairToolCall } from "../src/session/runner/repair-tool-call"

describe("RepairToolCall", () => {
  test("keeps advertised names", () => {
    const event = LLMEvent.toolCall({ id: "c1", name: "echo", input: { text: "hi" } })
    expect(RepairToolCall.repair(event, new Set(["echo"]), new Set()).name).toBe("echo")
  })

  test("lowercases when the advertised tool exists", () => {
    const event = LLMEvent.toolCall({ id: "c1", name: "Echo", input: { text: "hi" } })
    expect(RepairToolCall.repair(event, new Set(["echo"]), new Set()).name).toBe("echo")
  })

  test("routes unknown names to hidden invalid", () => {
    const event = LLMEvent.toolCall({ id: "c1", name: "missing", input: {} })
    const repaired = RepairToolCall.repair(event, new Set(["echo"]), new Set(["invalid"]))
    expect(repaired.name).toBe("invalid")
    expect(repaired.input).toEqual({ tool: "missing", error: "Unknown tool: missing" })
  })

  test("leaves unknown names unchanged when invalid is not registered", () => {
    const event = LLMEvent.toolCall({ id: "c1", name: "missing", input: {} })
    expect(RepairToolCall.repair(event, new Set(["echo"]), new Set()).name).toBe("missing")
  })
})
