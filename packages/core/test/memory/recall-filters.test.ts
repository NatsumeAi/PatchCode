import { describe, expect, test } from "bun:test"
import { filterRecallHits, DEFAULT_RECALL_MAX_AGE_DAYS, DEFAULT_RECALL_MIN_SCORE } from "../../src/memory/ranking"

describe("filterRecallHits", () => {
  test("drops session hits older than maxAgeDays; curated still age/score-exempt", () => {
    const kept = filterRecallHits(
      [
        { path: "sessions/a.md", score: 1, source: "session", ageDays: 45, text: "old" },
        { path: "sessions/b.md", score: 1, source: "session", ageDays: 5, text: "fresh" },
        // Curated keeps even with tiny FTS-like score (raw -bm25 often near 0).
        { path: "MEMORY.md", score: 0.000001, source: "workspace", ageDays: 999, text: "curated" },
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

  test("session minScore drops low decayed ranks; curated tiny FTS scores kept", () => {
    const kept = filterRecallHits(
      [
        { path: "a.md", score: 0.05, source: "session", ageDays: 1, text: "noise" },
        { path: "b.md", score: 0.5, source: "session", ageDays: 1, text: "ok" },
        { path: "MEMORY.md", score: 0.000001, source: "workspace", ageDays: 1, text: "fts best hit" },
      ],
      { maxAgeDays: 30, minScore: 0.15 },
    )
    expect(kept.map((h) => h.path)).toEqual(["b.md", "MEMORY.md"])
  })
})
