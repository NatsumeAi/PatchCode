import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const host = path.resolve(import.meta.dir, "../../src/tool/tool-host-bridges.ts")

describe("W6 opencode inventory", () => {
  test("task host isolation uses WorktreeEngine.acquire", () => {
    const text = fs.readFileSync(host, "utf8")
    expect(text).toContain("WorktreeEngine.acquire")
    expect(text).not.toContain("WorktreePool.acquire")
  })
})
