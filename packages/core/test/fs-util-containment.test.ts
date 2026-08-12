import { describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { FSUtil } from "../src/fs-util"

describe("FSUtil.assertWriteContained", () => {
  test("allows normal write under root", () => {
    const root = join(tmpdir(), `contain-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    try {
      const target = join(root, "file.txt")
      const resolved = FSUtil.assertWriteContained(root, target)
      expect(resolved.startsWith(root) || resolved.includes(root)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects symlink that escapes root", () => {
    const root = join(tmpdir(), `contain-esc-${Date.now()}`)
    const outside = join(tmpdir(), `outside-${Date.now()}`)
    mkdirSync(root, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, "secret.txt"), "nope")
    const link = join(root, "escape")
    try {
      symlinkSync(outside, link)
      expect(() => FSUtil.assertWriteContained(root, join(link, "secret.txt"))).toThrow(/escapes root/)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
