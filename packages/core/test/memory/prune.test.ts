import { describe, expect, test } from "bun:test"
import { selectPruneCandidates, PRUNE_ACCESS_THRESHOLD, PRUNE_AGE_DAYS, PRUNE_SYSTEM } from "../../src/memory/prune"

const now = Date.parse("2026-08-07T00:00:00Z")
const old = now - (PRUNE_AGE_DAYS + 1) * 24 * 60 * 60 * 1000
const fresh = now - 1000

describe("Memory prune", () => {
  test("thresholds are sane", () => {
    expect(PRUNE_ACCESS_THRESHOLD).toBe(3)
    expect(PRUNE_AGE_DAYS).toBe(90)
  })

  test("selects old low-access chunks only (by chunkId)", () => {
    const selected = selectPruneCandidates(
      [
        { chunkId: "c1", path: "MEMORY.md", excerpt: "old entry here", accessCount: 0, mtimeMs: old },
        { chunkId: "c2", path: "sessions/a.md", excerpt: "hot", accessCount: 10, mtimeMs: old },
        { chunkId: "c3", path: "MEMORY.md", excerpt: "fresh", accessCount: 1, mtimeMs: fresh },
        { chunkId: "c4", path: "MEMORY.md", excerpt: "old but accessed", accessCount: 3, mtimeMs: old },
      ],
      now,
    )
    expect(selected).toEqual([{ chunkId: "c1", path: "MEMORY.md", excerpt: "old entry here" }])
    expect(selected[0]?.chunkId).toBeDefined()
  })

  test("never returns bare archive paths without chunkId", () => {
    const selected = selectPruneCandidates(
      [{ chunkId: "", path: "MEMORY.md", excerpt: "whole file", accessCount: 0, mtimeMs: old }],
      now,
    )
    expect(selected).toEqual([])
  })

  test("PRUNE_SYSTEM mentions removal and scoping", () => {
    expect(PRUNE_SYSTEM.toLowerCase()).toContain("remove")
    expect(PRUNE_SYSTEM.toLowerCase()).toContain("unrelated")
  })
})
