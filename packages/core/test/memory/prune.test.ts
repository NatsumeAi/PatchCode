import { describe, expect, test } from "bun:test"
import {
  selectPruneCandidates,
  isPrunablePath,
  PRUNE_ACCESS_THRESHOLD,
  PRUNE_AGE_DAYS,
  PRUNE_SYSTEM,
} from "../../src/memory/prune"

const now = Date.parse("2026-08-07T00:00:00Z")
const old = now - (PRUNE_AGE_DAYS + 1) * 24 * 60 * 60 * 1000
const fresh = now - 1000

describe("Memory prune", () => {
  test("thresholds are sane", () => {
    expect(PRUNE_ACCESS_THRESHOLD).toBe(3)
    expect(PRUNE_AGE_DAYS).toBe(90)
  })

  test("isPrunablePath excludes curated MEMORY and summary", () => {
    expect(isPrunablePath("MEMORY.md")).toBe(false)
    expect(isPrunablePath("memory_summary.md")).toBe(false)
    expect(isPrunablePath("scope/MEMORY.md")).toBe(false)
    expect(isPrunablePath("scope/memory_summary.md")).toBe(false)
    expect(isPrunablePath("sessions/a.md")).toBe(true)
    expect(isPrunablePath("extensions/ad_hoc/notes/x.md")).toBe(true)
  })

  test("selects old low-access non-curated chunks only", () => {
    const selected = selectPruneCandidates(
      [
        { chunkId: "c1", path: "MEMORY.md", excerpt: "curated old", accessCount: 0, mtimeMs: old },
        { chunkId: "c2", path: "sessions/a.md", excerpt: "hot", accessCount: 10, mtimeMs: old },
        { chunkId: "c3", path: "sessions/stale.md", excerpt: "old entry here", accessCount: 0, mtimeMs: old },
        { chunkId: "c4", path: "memory_summary.md", excerpt: "summary", accessCount: 0, mtimeMs: old },
        { chunkId: "c5", path: "sessions/fresh.md", excerpt: "fresh", accessCount: 1, mtimeMs: fresh },
      ],
      now,
    )
    expect(selected).toEqual([{ chunkId: "c3", path: "sessions/stale.md", excerpt: "old entry here" }])
    expect(selected[0]?.chunkId).toBeDefined()
  })

  test("never returns bare archive paths without chunkId", () => {
    const selected = selectPruneCandidates(
      [{ chunkId: "", path: "sessions/a.md", excerpt: "whole file", accessCount: 0, mtimeMs: old }],
      now,
    )
    expect(selected).toEqual([])
  })

  test("PRUNE_SYSTEM is conservative with match-or-skip", () => {
    const lower = PRUNE_SYSTEM.toLowerCase()
    expect(lower).toContain("skip")
    expect(lower).toContain("when in doubt")
    expect(lower).toContain("keep")
    expect(lower).toContain("unrelated")
  })
})
