import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

const coreSrc = path.join(import.meta.dir, "../../src")
const shellTs = path.join(import.meta.dir, "../../../opencode/src/tool/shell.ts")

test("bash.ts no longer asserts the raw command as the only resource", async () => {
  const bash = await readFile(path.join(coreSrc, "tool/bash.ts"), "utf8")
  expect(bash).not.toMatch(/resources:\s*\[\s*input\.command\s*\]/)
})

test("missingAgentPermissions is deny", async () => {
  const permission = await readFile(path.join(coreSrc, "permission.ts"), "utf8")
  const block = permission.match(/const missingAgentPermissions[\s\S]*?\]/)?.[0]
  expect(block).toBeDefined()
  expect(block).toContain('effect: "deny"')
  expect(block).not.toContain('effect: "allow"')
})

test("V1 shell.ts does not own a bash parser", async () => {
  const shell = await readFile(shellTs, "utf8")
  expect(shell).not.toContain("Parser.init")
  expect(shell).not.toContain("tree-sitter-bash")
  expect(shell).toContain("wrapSpawn")
  expect(shell).toContain("decide(")
  expect(shell).toContain("classify(")
})

test("exec-policy does not classify with split &&", async () => {
  const dir = path.join(coreSrc, "exec-policy")
  const files = await readdir(dir)
  for (const file of files) {
    if (!file.endsWith(".ts") && !file.endsWith(".toml")) continue
    const text = await readFile(path.join(dir, file), "utf8")
    expect(text.includes('split("&&")') || text.includes("split('&&')")).toBe(false)
  }
})
