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

  test("connectLocal wrap is integration-child and argv0 is bwrap", async () => {
    if (process.platform !== "linux") return
    const { wrapSpawn } = await import("@opencode-ai/core/sandbox")
    const mcp = await readFile(path.join(src, "mcp/index.ts"), "utf8")
    expect(mcp).toContain("MCP.connectLocal")
    expect(mcp).toContain('class: "integration-child"')
    const wrapped = await wrapSpawn({
      class: "integration-child",
      command: "cat",
      args: [],
      cwd: "/tmp",
      whenUnpinned: "location",
      location: "/tmp",
      home: "/tmp",
    })
    expect(wrapped.command.includes("bwrap") || wrapped.args.some((arg) => String(arg).includes("bwrap"))).toBe(true)
    const dd = wrapped.args.lastIndexOf("--")
    expect(wrapped.args.slice(dd)).toEqual(["--", "cat"])
  })

  test("lsp server spawn helper argv0 is bwrap", async () => {
    if (process.platform !== "linux") return
    const { wrapSpawn } = await import("@opencode-ai/core/sandbox")
    const server = await readFile(path.join(src, "lsp/server.ts"), "utf8")
    expect(server).toContain("typescript-language-server")
    const wrapped = await wrapSpawn({
      class: "integration-child",
      command: "typescript-language-server",
      args: ["--stdio"],
      cwd: "/tmp",
      whenUnpinned: "location",
      location: "/tmp",
      home: "/tmp",
    })
    expect(wrapped.command.includes("bwrap") || wrapped.args.some((arg) => String(arg).includes("bwrap"))).toBe(true)
    expect(wrapped.args.at(-1)).toBe("--stdio")
    expect(wrapped.args.at(-2)).toBe("typescript-language-server")
  })

  test("formatter wrap is workspace-child with location default", async () => {
    const format = await readFile(path.join(src, "format/index.ts"), "utf8")
    expect(format).toContain('class: "workspace-child"')
    expect(format).toContain('whenUnpinned: "location"')
  })
})
