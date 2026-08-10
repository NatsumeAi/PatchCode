import { describe, expect, test } from "bun:test"
import { decayScore, rankResults, isContentFree, TEMPORAL_HALF_LIFE_DAYS, STALE_AFTER_DAYS, staleNote } from "../../src/memory/ranking"

describe("Memory ranking", () => {
  test("half-life is 7 days", () => {
    expect(TEMPORAL_HALF_LIFE_DAYS).toBe(7)
  })

  test("session decays, curated exempt", () => {
    const session = decayScore(1, 7, "session")
    expect(session).toBeLessThan(0.6)
    expect(decayScore(1, 7, "global")).toBe(1)
    expect(decayScore(1, 7, "workspace")).toBe(1)
  })

  test("rank sorts by decayed score with curated tie-break", () => {
    const ranked = rankResults([
      { path: "sessions/a.md", score: 0.8, source: "session", ageDays: 7 },
      { path: "MEMORY.md", score: 0.8, source: "workspace", ageDays: 0 },
    ])
    expect(ranked[0]!.path).toBe("MEMORY.md")
  })

  test("equal undecayed scores put workspace before global before session", () => {
    // Same score, same age (no decay to mask the tie-break): curated sources
    // (workspace > global) must sort before session chunks.
    const ranked = rankResults([
      { path: "sessions/a.md", score: 0.8, source: "session", ageDays: 0 },
      { path: "g/MEMORY.md", score: 0.8, source: "global", ageDays: 0 },
      { path: "w/MEMORY.md", score: 0.8, source: "workspace", ageDays: 0 },
    ])
    expect(ranked.map((item) => item.path)).toEqual(["w/MEMORY.md", "g/MEMORY.md", "sessions/a.md"])
  })

  test("higher decayed score wins over source tie-break", () => {
    const ranked = rankResults([
      { path: "MEMORY.md", score: 0.2, source: "workspace", ageDays: 0 },
      { path: "sessions/a.md", score: 0.9, source: "session", ageDays: 0 },
    ])
    expect(ranked[0]!.path).toBe("sessions/a.md")
  })

  test("staleness marks only old session chunks", () => {
    expect(STALE_AFTER_DAYS).toBe(14)
    expect(staleNote(20, "session")).toContain("may be stale")
    expect(staleNote(5, "session")).toBe("")
    expect(staleNote(20, "global")).toBe("")
    expect(staleNote(20, "workspace")).toBe("")
  })

  test("scaffold content is filtered", () => {
    expect(isContentFree("Add project-specific knowledge here")).toBe(true)
    expect(isContentFree("## Decisions\nUse layers")).toBe(false)
    expect(isContentFree("   ")).toBe(true)
  })
})
