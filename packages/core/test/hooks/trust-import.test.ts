import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import path from "node:path"
import { Trust } from "@opencode-ai/core/trust"

describe("W5 trust reuse", () => {
  test("hooks/ does not contain a second trust store", () => {
    const dir = path.resolve(import.meta.dir, "../../src/hooks")
    const names = readdirSync(dir)
    expect(names).not.toContain("trust.ts")
    for (const name of names) {
      expect(name.includes("trusted-folders")).toBe(false)
    }
  })

  test("Trust.grant is the W1 store", async () => {
    expect(typeof Trust.grant).toBe("function")
    expect(typeof Trust.isTrusted).toBe("function")
  })
})
