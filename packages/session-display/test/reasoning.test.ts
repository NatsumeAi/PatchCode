import { describe, expect, test } from "bun:test"
import type { ReasoningPart } from "@opencode-ai/sdk/v2"
import { resolveReasoningMode, buildReasoningViewModel, reasoningSummary } from "../src/parts/reasoning"
import { DEFAULT_CONFIG } from "../src/config"

function makeReasoning(text: string, end?: number): ReasoningPart {
  return {
    id: "part_r01",
    sessionID: "ses_001",
    messageID: "msg_001",
    type: "reasoning",
    text,
    time: { start: 1000, ...(end != null ? { end } : {}) },
  }
}

describe("§8.2 reasoning snapshots", () => {
  test("streaming new user → truncated", () => {
    const part = makeReasoning("Thinking about the problem...")
    const mode = resolveReasoningMode(part, null, null, DEFAULT_CONFIG)
    expect(mode).toBe("truncated")
  })

  test("done new user → collapsed", () => {
    const part = makeReasoning("Thought about the problem", 2000)
    const mode = resolveReasoningMode(part, null, null, DEFAULT_CONFIG)
    expect(mode).toBe("collapsed")
  })

  test("kv hide → collapsed always (streaming)", () => {
    const part = makeReasoning("Thinking...")
    const mode = resolveReasoningMode(part, "hide", null, DEFAULT_CONFIG)
    expect(mode).toBe("collapsed")
  })

  test("kv hide → collapsed always (done)", () => {
    const part = makeReasoning("Done thinking", 2000)
    const mode = resolveReasoningMode(part, "hide", null, DEFAULT_CONFIG)
    expect(mode).toBe("collapsed")
  })

  test("kv show → expanded always", () => {
    const part = makeReasoning("Thinking...", 2000)
    const mode = resolveReasoningMode(part, "show", null, DEFAULT_CONFIG)
    expect(mode).toBe("expanded")
  })

  test("pin overrides", () => {
    const part = makeReasoning("Done", 2000)
    const mode = resolveReasoningMode(part, null, "expanded", DEFAULT_CONFIG)
    expect(mode).toBe("expanded")
  })

  test("buildReasoningViewModel extracts title", () => {
    const part = makeReasoning("**Inspecting PR workflow**\n\nLooking at the CI config...", 2000)
    const vm = buildReasoningViewModel(part, null, null, DEFAULT_CONFIG)
    expect(vm.title).toBe("Inspecting PR workflow")
    expect(vm.body).toBe("Looking at the CI config...")
    expect(vm.durationMs).toBe(1000)
    expect(vm.status).toBe("done")
    expect(vm.mode).toBe("collapsed")
  })

  test("reasoningSummary without title", () => {
    const result = reasoningSummary("Just plain thinking text")
    expect(result.title).toBeNull()
    expect(result.body).toBe("Just plain thinking text")
  })
})
