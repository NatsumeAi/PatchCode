import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

describe("SessionCompaction.summaryBudget (MM formula)", () => {
  const anchor = (window: number, expected: number) => {
    const budget = SessionCompaction.summaryBudget(window)
    // ±5% tolerance
    expect(budget).toBeGreaterThanOrEqual(Math.floor(expected * 0.95))
    expect(budget).toBeLessThanOrEqual(Math.ceil(expected * 1.05))
  }

  test("anchors: 128K→6400, 272K→10000, 1M→15700, 2M→17600", () => {
    anchor(128_000, 6400)
    anchor(272_000, 10000)
    anchor(1_000_000, 15700)
    anchor(2_000_000, 17600)
  })

  test("monotonically increases with the window and stays under 20000", () => {
    let previous = 0
    for (const window of [32_000, 64_000, 128_000, 272_000, 1_000_000, 2_000_000]) {
      const budget = SessionCompaction.summaryBudget(window)
      expect(budget).toBeGreaterThanOrEqual(previous)
      expect(budget).toBeLessThanOrEqual(20_000)
      previous = budget
    }
  })

  test("zero and negative windows yield a small floor budget", () => {
    expect(SessionCompaction.summaryBudget(0)).toBeGreaterThan(0)
    expect(SessionCompaction.summaryBudget(-5)).toBeGreaterThan(0)
  })
})
