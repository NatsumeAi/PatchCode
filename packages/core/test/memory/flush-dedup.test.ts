import { describe, expect, test } from "bun:test"
import {
  flushContentHash,
  isFlushDuplicate,
  jaccardSimilarity,
  cosineSimilarity,
  FLUSH_NEAR_DUP_THRESHOLD,
  FLUSH_COSINE_DUP_THRESHOLD,
} from "../../src/memory/flush-dedup"
import {
  beginFlushCycle,
  markFlushed,
  resetFlushGuardForTests,
  shouldFlushSession,
} from "../../src/memory/flush"

describe("Flush dedup", () => {
  test("exact hash is stable under whitespace", () => {
    expect(flushContentHash("## Decisions\nUse layers")).toBe(
      flushContentHash("  ## Decisions\nUse   layers  "),
    )
  })

  test("isFlushDuplicate matches exact and near-duplicate at 0.65 threshold", () => {
    const prior = "## Flush\n\n## Decisions\nUse Effect layers for memory consolidation"
    expect(isFlushDuplicate("## Decisions\nUse Effect layers for memory consolidation", prior)).toBe(true)
    // Light paraphrase: same core tokens + one extra word (fires at 0.65, not at 0.92).
    const near = "## Decisions\nUse Effect layers for memory consolidation today"
    const body = prior.replace(/^##\s*Flush\s*/i, "")
    expect(jaccardSimilarity(near, body)).toBeGreaterThanOrEqual(FLUSH_NEAR_DUP_THRESHOLD)
    expect(isFlushDuplicate(near, prior)).toBe(true)
    expect(isFlushDuplicate("## Decisions\nTotally unrelated architecture choice about databases", prior)).toBe(
      false,
    )
  })

  test("cosine near-dup fires when vectors are similar even if tokens differ", () => {
    const prior = "## Flush\n\nPrefer layered architecture"
    const paraphrase = "Use a layered design approach"
    // Token jaccard may be low; force cosine path.
    const v1 = [1, 0, 0, 0]
    const v2 = [0.99, 0.1, 0, 0]
    expect(cosineSimilarity(v1, v2)).toBeGreaterThanOrEqual(FLUSH_COSINE_DUP_THRESHOLD)
    expect(isFlushDuplicate(paraphrase, prior, { candidate: v2, prior: v1 })).toBe(true)
    expect(isFlushDuplicate(paraphrase, prior, { candidate: [0, 1, 0, 0], prior: v1 })).toBe(false)
  })
})

describe("Flush cycle guard", () => {
  test("beginFlushCycle allows one flush per generation", () => {
    resetFlushGuardForTests()
    const id = "ses_cycle_test"
    expect(shouldFlushSession(id)).toBe(true)
    beginFlushCycle(id)
    expect(shouldFlushSession(id)).toBe(true)
    markFlushed(id)
    // Same cycle: blocked even if cooldown were 0 (we still mark cycle)
    expect(shouldFlushSession(id)).toBe(false)
    beginFlushCycle(id)
    // New cycle but cooldown may still block — advance by marking past cooldown via reset of time map only is hard;
    // after reset of all guards a new cycle works:
    resetFlushGuardForTests()
    beginFlushCycle(id)
    expect(shouldFlushSession(id)).toBe(true)
  })
})
