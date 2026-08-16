import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const coreSrc = path.resolve(import.meta.dir, "../../src")
const packagesRoot = path.resolve(import.meta.dir, "../../..")
const pool = path.join(coreSrc, "session/worktree-pool.ts")
const host = path.join(packagesRoot, "opencode/src/tool/tool-host-bridges.ts")
const builtins = path.join(coreSrc, "tool/builtins.ts")
const gitBackend = path.join(coreSrc, "worktree-engine/git.ts")

describe("W6 inventory", () => {
  test("worktree-pool is a wrapper around the engine, not a second git worktree add", () => {
    const text = fs.readFileSync(pool, "utf8")
    expect(text).toContain("WorktreeEngine")
    expect(text).not.toContain('["worktree", "add"')
    expect(text).not.toContain("git worktree add")
  })

  test("task host isolation calls WorktreeEngine.acquire", () => {
    const text = fs.readFileSync(host, "utf8")
    expect(text).toContain("WorktreeEngine.acquire")
    expect(text).toContain('isolation === "worktree"')
    expect(text).not.toContain("WorktreePool.acquire")
  })

  test("worktree tool is registered in builtins", () => {
    const text = fs.readFileSync(builtins, "utf8")
    expect(text).toContain("WorktreeTool.node")
  })

  test("git backend marks spawns sandbox:host", () => {
    const text = fs.readFileSync(gitBackend, "utf8")
    expect(text).toContain("sandbox:host")
    expect(text).toContain('["worktree", "add"')
  })
})
