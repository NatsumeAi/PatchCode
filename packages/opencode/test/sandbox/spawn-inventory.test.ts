import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const src = path.resolve(import.meta.dir, "../../src")

const mustWrap = {
  "mcp/index.ts": "StdioClientTransport",
  "lsp/launch.ts": "wrapSpawn",
  "lsp/server.ts": "wrapSpawn",
  "format/index.ts": "wrapSpawn",
}

describe("opencode spawn inventory", () => {
  test("agent-facing spawn sites call wrapSpawn", async () => {
    for (const [rel, token] of Object.entries(mustWrap)) {
      const text = await readFile(path.join(src, rel), "utf8")
      expect(text.includes("wrapSpawn"), rel).toBe(true)
      expect(text.includes(token), `${rel} ${token}`).toBe(true)
    }
  })

  test("lsp/server.ts language-server helper wraps; installers are host", async () => {
    const text = await readFile(path.join(src, "lsp/server.ts"), "utf8")
    expect(text).toContain("wrapSpawn")
    expect(text).toContain('class: "integration-child"')
    const lines = text.split("\n")
    const installers = lines.filter(
      (line) =>
        line.includes("Process.spawn") &&
        (/go["',\s]+install/.test(line) || /gem["',\s]+install/.test(line) || /dotnet["',\s]+tool["',\s]+install/.test(line)),
    )
    expect(installers.length).toBeGreaterThan(0)
    for (const line of installers) {
      expect(line).toContain("// sandbox:host")
    }
  })

  test("snapshot git spawns are host", async () => {
    const text = await readFile(path.join(src, "snapshot/index.ts"), "utf8")
    const lines = text.split("\n").filter((line) => line.includes('ChildProcess.make("git"'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toContain("// sandbox:host")
    }
  })
})
