import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const host = path.resolve(import.meta.dir, "../../../opencode/src/tool/tool-host-bridges.ts")

describe("W6 task isolation wiring", () => {
  test("isolation worktree sets child cwd from WorktreeEngine.acquire dir", () => {
    const text = fs.readFileSync(host, "utf8")
    expect(text).toContain("WorktreeEngine.acquire")
    expect(text).toContain("childDirectory = wt.value.dir")
    expect(text).toContain("worktreeId")
  })
})
