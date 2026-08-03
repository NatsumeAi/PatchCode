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

describe("SessionCompaction.selectedBudgetCap (P1-4 full total budget)", () => {
  // summary + selected + recent + system/tools ≤ context − buffer
  // selectedBudgetCap returns the residual for `selected`.

  test("200K window: recent 20k + summary 8.5k + system 10k leaves room under 20k select ratio", () => {
    const summary = SessionCompaction.summaryBudget(200_000) // ~8.5k
    const cap = SessionCompaction.selectedBudgetCap({
      contextWindow: 200_000,
      buffer: 20_000,
      summaryTokens: summary,
      recentTokens: 20_000,
      systemToolsTokens: 10_000,
    })
    // capacity 180k − (8.5k + 20k + 10k) ≈ 141.5k; configured 10% is 20k → cap is residual, not ratio
    expect(cap).toBeGreaterThan(100_000)
    expect(summary + 20_000 + cap + 10_000).toBeLessThanOrEqual(200_000 - 20_000)
  })

  test("tight window: large system+recent shrinks selected to near zero", () => {
    // 32k window, buffer 3.2k → capacity 28.8k; fixed 2.1k + 12k + 14k = 28.1k → residual ~0.7k
    const cap = SessionCompaction.selectedBudgetCap({
      contextWindow: 32_000,
      buffer: 3_200,
      summaryTokens: 2_100,
      recentTokens: 12_000,
      systemToolsTokens: 14_000,
    })
    expect(cap).toBeLessThan(1_000)
    expect(cap).toBeGreaterThanOrEqual(0)
    expect(2_100 + cap + 12_000 + 14_000).toBeLessThanOrEqual(32_000 - 3_200)
  })

  test("when fixed cost already exceeds capacity, selected cap is 0 (recent protected)", () => {
    const cap = SessionCompaction.selectedBudgetCap({
      contextWindow: 32_000,
      buffer: 3_200,
      summaryTokens: 5_000,
      recentTokens: 20_000,
      systemToolsTokens: 15_000,
    })
    expect(cap).toBe(0)
  })

  test("packLargestFirst keeps biggest items that fit and drops the rest", () => {
    const items = [
      { label: "1", tokens: 500 },
      { label: "2", tokens: 300 },
      { label: "3", tokens: 100 },
    ]
    expect(SessionCompaction.packLargestFirst(items, 600)).toEqual(["1", "3"])
    expect(SessionCompaction.packLargestFirst(items, 0)).toEqual([])
    expect(SessionCompaction.packLargestFirst(items, 50)).toEqual([])
    expect(SessionCompaction.packLargestFirst(items, 900)).toEqual(["1", "2", "3"])
  })
})
