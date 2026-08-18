import { describe, expect, test } from "bun:test"
import { wrapSpawn } from "@opencode-ai/core/sandbox"

test("MCP stdio wrap is integration-child and begins with bwrap when profile !== off", async () => {
  if (process.platform !== "linux") return
  const wrapped = await wrapSpawn({
    class: "integration-child",
    command: "cat",
    args: [],
    cwd: "/tmp",
    profileName: "workspace",
    location: "/tmp",
    home: "/tmp",
  })
  expect(wrapped.command.includes("bwrap") || wrapped.args.some((arg) => String(arg).includes("bwrap"))).toBe(true)
  expect(wrapped.args).not.toContain("--unshare-net")
  const dd = wrapped.args.indexOf("--")
  expect(wrapped.args.slice(dd)).toEqual(["--", "cat"])
})

test("read-only workspace-child wrap includes unshare-net (webfetch is not wrapSpawn)", async () => {
  if (process.platform !== "linux") return
  const wrapped = await wrapSpawn({
    class: "workspace-child",
    command: "/bin/sh",
    args: ["-c", "true"],
    cwd: "/tmp",
    profileName: "read-only",
    location: "/tmp",
    home: "/tmp",
  })
  expect(wrapped.args).toContain("--unshare-net")
})
