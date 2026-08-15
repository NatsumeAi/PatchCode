import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Trust } from "../src/trust"

describe("Trust", () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("empty store does not trust a tmp dir", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "oc-trust-cfg-"))
    const repo = await mkdtemp(path.join(os.tmpdir(), "oc-trust-repo-"))
    dirs.push(configDir, repo)
    expect(await Trust.isTrusted(repo, { configDir })).toBe(false)
  })

  test("grant then prefix-match subdir, not a sibling name", async () => {
    const configDir = await mkdtemp(path.join(os.tmpdir(), "oc-trust-cfg-"))
    const repo = await mkdtemp(path.join(os.tmpdir(), "oc-trust-repo-"))
    const nested = path.join(repo, "src")
    await mkdir(nested)
    dirs.push(configDir, repo)
    const granted = await Trust.grant(repo, { configDir })
    expect(path.resolve(granted)).toBe(path.resolve(repo))
    expect(await Trust.isTrusted(repo, { configDir })).toBe(true)
    expect(await Trust.isTrusted(nested, { configDir })).toBe(true)
    expect(await Trust.isTrusted(`${repo}-other`, { configDir })).toBe(false)
    expect(await Trust.list({ configDir })).toContain(granted)
  })
})
