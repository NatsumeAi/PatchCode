import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { decide } from "../../src/exec-policy/decide"
import { loadMerged } from "../../src/exec-policy/service"

describe("exec-policy merge", () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("user toml overlays builtin", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "oc-ep-cfg-"))
    const locationDir = await mkdtemp(path.join(os.tmpdir(), "oc-ep-loc-"))
    dirs.push(configDir, locationDir)
    await writeFile(
      path.join(configDir, "exec-policy.toml"),
      `[[rule]]\nprefix = ["curl"]\neffect = "deny"\n`,
    )
    const policy = await loadMerged({ configDir, locationDir, trusted: false })
    expect(decide(policy, { tag: "segments", segments: [["curl", "https://example.com"]] }).effect).toBe("deny")
    expect(decide(policy, { tag: "segments", segments: [["git", "status"]] }).effect).toBe("allow")
  })

  test("untrusted project toml is ignored", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "oc-ep-cfg-"))
    const locationDir = await mkdtemp(path.join(os.tmpdir(), "oc-ep-loc-"))
    dirs.push(configDir, locationDir)
    await mkdir(path.join(locationDir, ".opencode"), { recursive: true })
    await writeFile(
      path.join(locationDir, ".opencode", "exec-policy.toml"),
      `[[rule]]\nprefix = ["ls"]\neffect = "deny"\n`,
    )
    const untrusted = await loadMerged({ configDir, locationDir, trusted: false })
    expect(decide(untrusted, { tag: "segments", segments: [["ls"]] }).effect).toBe("allow")
    expect(untrusted.skippedUntrusted).toBe(path.join(locationDir, ".opencode", "exec-policy.toml"))
    const trusted = await loadMerged({ configDir, locationDir, trusted: true })
    expect(decide(trusted, { tag: "segments", segments: [["ls"]] }).effect).toBe("deny")
  })
})
