import { describe, expect, test } from "bun:test"
import { assertPath } from "../../src/sandbox/assert-path"
import { builtInProfile, mergeCustom, DEFAULT_DENY_GLOBS } from "../../src/sandbox/profile"

test("workspace allows write inside location", () => {
  const p = builtInProfile("workspace", { location: "/repo", home: "/home/u", tmp: "/tmp", opencodeTmp: "/tmp/opencode" })
  expect(assertPath(p, "write", "/repo/a.ts")._tag).toBe("Allow")
})

test("workspace denies write to home probe", () => {
  const p = builtInProfile("workspace", { location: "/repo", home: "/home/u", tmp: "/tmp", opencodeTmp: "/tmp/opencode" })
  expect(assertPath(p, "write", "/home/u/opencode-sandbox-probe")._tag).toBe("Deny")
})

test("default deny blocks .env even inside location", () => {
  const p = builtInProfile("workspace", { location: "/repo", home: "/home/u", tmp: "/tmp", opencodeTmp: "/tmp/opencode" })
  expect(assertPath(p, "read", "/repo/.env")._tag).toBe("Deny")
  expect(assertPath(p, "read", "/repo/.env.example")._tag).toBe("Allow")
})

test("off never denies", () => {
  const p = builtInProfile("off", { location: "/repo", home: "/home/u", tmp: "/tmp", opencodeTmp: "/tmp/opencode" })
  expect(assertPath(p, "write", "/home/u/.ssh/id_rsa")._tag).toBe("Allow")
})

test("strict denies read outside read roots", () => {
  const p = builtInProfile("strict", { location: "/repo", home: "/home/u", tmp: "/tmp", opencodeTmp: "/tmp/opencode" })
  expect(assertPath(p, "read", "/repo/src/a.ts")._tag).toBe("Allow")
  expect(assertPath(p, "read", "/home/u/secrets.txt")._tag).toBe("Deny")
  expect(assertPath(p, "read", "/usr/bin/sh")._tag).toBe("Allow")
})

test("default deny blocks .ssh descendants", () => {
  const p = builtInProfile("workspace", { location: "/repo", home: "/home/u", tmp: "/tmp", opencodeTmp: "/tmp/opencode" })
  expect(assertPath(p, "read", "/home/u/.ssh/id_rsa")._tag).toBe("Deny")
  expect(assertPath(p, "read", "/repo/.env.local")._tag).toBe("Deny")
})

test("workspace and read-only cannot write config dir", () => {
  const ctx = {
    location: "/repo",
    home: "/home/u",
    tmp: "/tmp",
    opencodeTmp: "/tmp/opencode",
    config: "/home/u/.config/opencode",
    data: "/home/u/.local/share/opencode",
  }
  const workspace = builtInProfile("workspace", ctx)
  const readonly = builtInProfile("read-only", ctx)
  expect(assertPath(workspace, "write", "/home/u/.config/opencode/trusted-folders.json")._tag).toBe("Deny")
  expect(assertPath(readonly, "write", "/home/u/.config/opencode/exec-policy.toml")._tag).toBe("Deny")
})

test("extends=off keeps default deny globs", () => {
  const ctx = { location: "/repo", home: "/home/u", tmp: "/tmp", opencodeTmp: "/tmp/opencode" }
  const merged = mergeCustom({ extends: "off" }, ctx)
  for (const glob of DEFAULT_DENY_GLOBS) expect(merged.denyGlobs).toContain(glob)
})
