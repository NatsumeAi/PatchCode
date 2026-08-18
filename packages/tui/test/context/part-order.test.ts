import { describe, expect, test } from "bun:test"
import type { Part, ReasoningPart, TextPart, ToolPart } from "@opencode-ai/sdk/api"
import { comparePartOrder, insertPartIndex, partOrderKey } from "../../src/context/part-order"

function reasoning(id: string, start: number): ReasoningPart {
  return {
    id,
    sessionID: "ses",
    messageID: "msg",
    type: "reasoning",
    text: "think",
    time: { start },
  }
}

function tool(id: string, start: number, name = "read"): ToolPart {
  return {
    id,
    sessionID: "ses",
    messageID: "msg",
    type: "tool",
    tool: name,
    callID: id,
    state: {
      status: "running",
      input: {},
      time: { start },
    },
  }
}

function text(id: string, start: number, body = "hello"): TextPart {
  return {
    id,
    sessionID: "ses",
    messageID: "msg",
    type: "text",
    text: body,
    time: { start },
  }
}

describe("part chronological order", () => {
  test("reasoning before tool when thinking finishes then tools start", () => {
    // Provider ids often sort the wrong way: "call_…" < "reasoning_…"
    const r = reasoning("prt_msg_reasoning_0", 1000)
    const t = tool("prt_msg_call_abc", 1001)
    expect(comparePartOrder(r, t)).toBeLessThan(0)
    expect(partOrderKey(r).t).toBe(1000)
    expect(partOrderKey(t).t).toBe(1001)
  })

  test("insert keeps thought above later tool even if tool id sorts first", () => {
    const r = reasoning("prt_msg_zzz_reasoning", 1000)
    const t = tool("prt_msg_aaa_call", 1100)
    // id-only order would put tool first (aaa < zzz)
    expect(r.id > t.id).toBe(true)

    let parts: Part[] = []
    parts = [...parts]
    parts.splice(insertPartIndex(parts, t), 0, t)
    parts.splice(insertPartIndex(parts, r), 0, r)
    // tool arrived first in this scenario; re-insert reasoning by time → before tool
    expect(parts.map((p) => p.type)).toEqual(["reasoning", "tool"])
  })

  test("arrival order: reasoning then tool", () => {
    const r = reasoning("prt_msg_r1", 1000)
    const t = tool("prt_msg_t1", 1001)
    let parts: Part[] = []
    parts.splice(insertPartIndex(parts, r), 0, r)
    parts.splice(insertPartIndex(parts, t), 0, t)
    expect(parts.map((p) => p.type)).toEqual(["reasoning", "tool"])
  })

  test("same timestamp: reasoning ranks before tool", () => {
    const r = reasoning("prt_msg_r", 5000)
    const t = tool("prt_msg_t", 5000)
    expect(comparePartOrder(r, t)).toBeLessThan(0)
    let parts: Part[] = [t]
    parts.splice(insertPartIndex(parts, r), 0, r)
    expect(parts.map((p) => p.type)).toEqual(["reasoning", "tool"])
  })

  test("text before later tool when both have start times", () => {
    const tx = text("prt_msg_text", 1000)
    const t = tool("prt_msg_call", 1100)
    expect(comparePartOrder(tx, t)).toBeLessThan(0)
    let parts: Part[] = []
    parts.splice(insertPartIndex(parts, t), 0, t)
    parts.splice(insertPartIndex(parts, tx), 0, tx)
    expect(parts.map((p) => p.type)).toEqual(["text", "tool"])
  })

  test("reasoning → text → tool chronological", () => {
    const r = reasoning("prt_r", 1000)
    const tx = text("prt_txt", 1050)
    const t = tool("prt_tool", 1100)
    let parts: Part[] = []
    for (const p of [t, tx, r]) parts.splice(insertPartIndex(parts, p), 0, p)
    expect(parts.map((p) => p.type)).toEqual(["reasoning", "text", "tool"])
  })
})
