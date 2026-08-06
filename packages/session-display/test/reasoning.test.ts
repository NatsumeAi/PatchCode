import { describe, expect, test } from "bun:test"
import type { ReasoningPart } from "@opencode-ai/sdk/v2"
import {
  applyReasoningHoldOpen,
  buildReasoningViewModel,
  reasoningSummary,
  resolveReasoningMode,
  shouldHoldReasoningOpen,
} from "../src/parts/reasoning"
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
  test("streaming new user → expanded (live thinking visible)", () => {
    const part = makeReasoning("Thinking about the problem...")
    const mode = resolveReasoningMode(part, null, null, DEFAULT_CONFIG)
    expect(mode).toBe("expanded")
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
    expect(vm.clickable).toBe(true)
  })

  test("duration from ISO timestamps (SSE DateTime JSON) does not produce NaN", () => {
    const part: ReasoningPart = {
      id: "part_r01",
      sessionID: "ses_001",
      messageID: "msg_001",
      type: "reasoning",
      text: "done",
      time: {
        start: "2026-08-03T05:43:22.000Z" as unknown as number,
        end: "2026-08-03T05:43:24.500Z" as unknown as number,
      },
    }
    const vm = buildReasoningViewModel(part, null, null, DEFAULT_CONFIG)
    expect(vm.status).toBe("done")
    expect(vm.durationMs).toBe(2500)
    expect(Number.isFinite(vm.durationMs)).toBe(true)
  })

  test("reasoningSummary without title", () => {
    const result = reasoningSummary("Just plain thinking text")
    expect(result.title).toBeNull()
    expect(result.body).toBe("Just plain thinking text")
  })
  test("title-only done thought stays visible and clickable", () => {
    const part = makeReasoning("**Inspecting PR workflow**\n\n", 2000)
    // Force empty body after title extraction
    const vm = buildReasoningViewModel(
      { ...part, text: "**Inspecting PR workflow**" },
      null,
      null,
      DEFAULT_CONFIG,
    )
    expect(vm.title).toBe("Inspecting PR workflow")
    expect(vm.body).toBe("")
    expect(vm.status).toBe("done")
    expect(vm.clickable).toBe(true)
  })
})

describe("reasoning hold-open after end (batched SSE)", () => {
  test("auto + just ended → hold open", () => {
    expect(
      shouldHoldReasoningOpen({
        status: "done",
        mode: "collapsed",
        userPinned: false,
        storedMode: null,
        endedAtMs: 10_000,
        nowMs: 10_500,
      }),
    ).toBe(true)
  })

  test("auto + ended long ago → no hold", () => {
    expect(
      shouldHoldReasoningOpen({
        status: "done",
        mode: "collapsed",
        userPinned: false,
        storedMode: null,
        endedAtMs: 10_000,
        nowMs: 20_000,
      }),
    ).toBe(false)
  })

  test("kv hide never holds open", () => {
    expect(
      shouldHoldReasoningOpen({
        status: "done",
        mode: "collapsed",
        userPinned: false,
        storedMode: "hide",
        endedAtMs: 10_000,
        nowMs: 10_100,
      }),
    ).toBe(false)
  })

  test("applyReasoningHoldOpen expands auto just-finished thought", () => {
    const part = makeReasoning("Thought text", 10_000)
    const vm = buildReasoningViewModel(part, null, null, DEFAULT_CONFIG)
    expect(vm.mode).toBe("collapsed")
    const held = applyReasoningHoldOpen(vm, {
      storedMode: null,
      endedAtMs: 10_000,
      nowMs: 10_200,
    })
    expect(held.mode).toBe("expanded")
  })
})
