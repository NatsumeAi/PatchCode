import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const coreRoot = path.resolve(import.meta.dir, "../../src")
const mustWrap = ["tool/bash.ts", "pty.ts", "ripgrep.ts"]
const hostFiles = ["git.ts", "session/worktree-pool.ts"]

const spawnRe = /Process\.spawn|StdioClientTransport\(|#pty|pty\.spawn|spawn\(|ChildProcess\.make\(/

describe("core spawn inventory", () => {
  test("agent-facing files call wrapSpawn", async () => {
    for (const rel of mustWrap) {
      const text = await readFile(path.join(coreRoot, rel), "utf8")
      expect(text.includes("wrapSpawn"), rel).toBe(true)
    }
  })

  test("webfetch does not call wrapSpawn", async () => {
    const text = await readFile(path.join(coreRoot, "tool/webfetch.ts"), "utf8")
    expect(text.includes("wrapSpawn")).toBe(false)
  })

  test("host files mark sandbox:host on spawn lines", async () => {
    for (const rel of hostFiles) {
      const text = await readFile(path.join(coreRoot, rel), "utf8")
      const lines = text.split("\n")
      const spawnLines = lines.filter((line) => spawnRe.test(line) && !line.trim().startsWith("//") && !line.includes("wrapSpawn"))
      const unmarked = spawnLines.filter((line) => !line.includes("// sandbox:host"))
      expect(unmarked, rel).toEqual([])
    }
  })
})
