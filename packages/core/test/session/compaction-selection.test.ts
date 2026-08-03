import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import type { TurnItem } from "@opencode-ai/core/session/compaction"

const item = (label: string, tokens: number): TurnItem => ({
  key: `msg-${label}`,
  kind: "turn",
  label,
  tokens,
  survival: 0,
  entries: [],
})

const items = [item("1", 100), item("2", 200), item("3", 300), item("4", 400)]

describe("SessionCompaction.parseSelection", () => {
  test("parses a JSON array inside the tag", () => {
    const result = SessionCompaction.parseSelection('summary text\n<selection>[1,3]</selection>\ntrailing')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.selected).toEqual(["1", "3"])
  })

  test("tolerates the tag at the start and at the end", () => {
    const start = SessionCompaction.parseSelection('<selection>[2]</selection>\nsummary')
    const end = SessionCompaction.parseSelection('summary\n<selection>[2]</selection>')
    expect(start.ok).toBe(true)
    expect(end.ok).toBe(true)
    if (start.ok) expect(start.selected).toEqual(["2"])
    if (end.ok) expect(end.selected).toEqual(["2"])
  })

  test("falls back to splitting a bare number list without JSON quotes", () => {
    const result = SessionCompaction.parseSelection('<selection>[1, 2, 4]</selection>')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.selected).toEqual(["1", "2", "4"])
  })

  test("rejects missing tags but accepts empty selections (P0-1/N1)", () => {
    expect(SessionCompaction.parseSelection("no tag here").ok).toBe(false)
    // empty and whitespace-only tags are zero selections, not failures (N1)
    const bare = SessionCompaction.parseSelection("<selection></selection>")
    expect(bare.ok).toBe(true)
    if (bare.ok) expect(bare.selected).toEqual([])
    const blank = SessionCompaction.parseSelection("<selection>   </selection>")
    expect(blank.ok).toBe(true)
    // <selection>[]</selection> is the canonical zero-selection outcome
    const empty = SessionCompaction.parseSelection("<selection>[]</selection>")
    expect(empty.ok).toBe(true)
    if (empty.ok) expect(empty.selected).toEqual([])
  })

  test("rejects non-array content", () => {
    expect(SessionCompaction.parseSelection("<selection>{\"a\":1}</selection>").ok).toBe(false)
  })
})

describe("SessionCompaction.validateSelection", () => {
  test("accepts a selection within the budget", () => {
    const result = SessionCompaction.validateSelection({ selected: ["1", "2"], items, limit: 1000, maxItems: 10 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.tokens).toBe(300)
  })

  test("accepts a selection up to 1.5x the limit", () => {
    // limit 300 → 1.5x = 450; items 1+2+3 = 600 is over; items 1+2 = 300 ≤ 450 ok
    const result = SessionCompaction.validateSelection({ selected: ["1", "2"], items, limit: 300, maxItems: 10 })
    expect(result.ok).toBe(true)
  })

  test("marks over-1.5x selections for reselection", () => {
    const result = SessionCompaction.validateSelection({ selected: ["1", "2", "3", "4"], items, limit: 300, maxItems: 10 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.overBudget).toBe(true)
      expect(result.selectedTokens).toBe(1000)
    }
  })

  test("rejects unknown item numbers", () => {
    const result = SessionCompaction.validateSelection({ selected: ["1", "9"], items, limit: 1000, maxItems: 10 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.includes("unknown"))).toBe(true)
  })

  test("rejects selections over the item-count cap", () => {
    const result = SessionCompaction.validateSelection({ selected: ["1", "2", "3", "4"], items, limit: 10_000, maxItems: 2 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.some((e) => e.includes("too many"))).toBe(true)
  })
})
