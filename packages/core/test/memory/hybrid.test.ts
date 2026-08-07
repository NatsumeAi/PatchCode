import { describe, expect, test } from "bun:test"
import { cosineSimilarity, normalize01, hybridScore, applyMmr, DEFAULT_VECTOR_WEIGHT, DEFAULT_TEXT_WEIGHT } from "../../src/memory/hybrid"

describe("Hybrid scoring", () => {
  test("cosine of identical vectors is 1", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  test("normalize01 maps to [0,1]", () => {
    expect(normalize01([2, 4, 8])).toEqual([0, 1 / 3, 1])
  })

  test("weights default to 0.7/0.3", () => {
    expect(DEFAULT_VECTOR_WEIGHT).toBe(0.7)
    expect(DEFAULT_TEXT_WEIGHT).toBe(0.3)
    expect(hybridScore(1, 1)).toBeCloseTo(1)
    expect(hybridScore(0, 1)).toBeCloseTo(0.3)
  })

  test("MMR penalizes redundancy", () => {
    const items = [
      { id: "a", score: 0.9, text: "auth uses tokens" },
      { id: "b", score: 0.85, text: "auth tokens session" },
      { id: "c", score: 0.8, text: "database schema" },
    ]
    const mmr = applyMmr(items, 0.7, 2)
    expect(mmr[0]!.id).toBe("a")
    expect(mmr[1]!.id).toBe("c")
  })
})
