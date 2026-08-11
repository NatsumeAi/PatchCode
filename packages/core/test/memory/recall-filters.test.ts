import { describe, expect, test } from "bun:test"
import { filterRecallHits, DEFAULT_RECALL_MAX_AGE_DAYS, DEFAULT_RECALL_MIN_SCORE } from "../../src/memory/ranking"

describe("filterRecallHits", () => {
  test("drops session hits older than maxAgeDays", () => {
    const kept = filterRecallHits(
      [
        { path: "sessions/a.md", score: 1, source: "session", ageDays: 45, text: "old" },
        { path: "sessions/b.md", score: 1, source: "session", ageDays: 5, text: "fresh" },
        { path: "MEMORY.md", score: 0.1, source: "workspace", ageDays: 999, text: "curated" },
      ],
      { maxAgeDays: 30, minScore: 0.15 },
    )
    expect(kept.map((h) => h.path)).toEqual(["sessions/b.md", "MEMORY.md"])
  })

  test("fail-open when ageDays is missing/NaN", () => {
    const kept = filterRecallHits(
      [{ path: "x.md", score: 1, source: "session", ageDays: Number.NaN, text: "unk" }],
      { maxAgeDays: 30, minScore: 0.15 },
    )
    expect(kept).toHaveLength(1)
  })

  test("drops low decayed scores but keeps missing score", () => {
    const kept = filterRecallHits(
      [
        { path: "a.md", score: 0.05, source: "session", ageDays: 1, text: "noise" },
        { path: "b.md", score: 0.5, source: "session", ageDays: 1, text: "ok" },
      ],
      { maxAgeDays: 30, minScore: 0.15 },
    )
    expect(kept.map((h) => h.path)).toEqual(["b.md"])
  })
})
