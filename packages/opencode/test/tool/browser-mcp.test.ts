import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

describe("W8g browser host adapters", () => {
  test("OPENCODE_BROWSER_MCP adapter is present", () => {
    const src = readFileSync(path.resolve(import.meta.dir, "../../src/tool/browser-host.ts"), "utf8")
    expect(src).toContain("OPENCODE_BROWSER_MCP")
    expect(src).toContain("mcpHostNode")
  })
})

describe("W8h SDK skills.install", () => {
  test("experimental.skills.install posts to /experimental/skills/install", () => {
    const sdk = readFileSync(path.resolve(import.meta.dir, "../../../sdk/js/src/v2/gen/sdk.gen.ts"), "utf8")
    expect(sdk).toContain("class Skills")
    expect(sdk).toContain("/experimental/skills/install")
    expect(sdk).toContain("get skills()")
  })
})
