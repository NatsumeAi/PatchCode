import { describe, expect, test } from "bun:test"
import { probe } from "@opencode-ai/core/worktree-engine"

describe("W6 probe", () => {
  test("returns a known backend and git on this host", () => {
    const name = probe()
    expect(["git", "overlay", "btrfs", "reflink"]).toContain(name)
    expect(name).toBe("git")
  })
})
