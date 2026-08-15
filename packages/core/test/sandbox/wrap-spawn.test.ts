import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildDarwinWrap } from "../../src/sandbox/darwin-seatbelt"
import { buildLinuxWrap } from "../../src/sandbox/linux-bwrap"
import { builtInProfile } from "../../src/sandbox/profile"
import { ensureBackend } from "../../src/sandbox/resolve"
import { wrapSpawn } from "../../src/sandbox/wrap-spawn"
import { windowsRefuse } from "../../src/sandbox/windows"

const ctx = {
  location: "/repo",
  home: "/home/u",
  tmp: "/tmp",
  opencodeTmp: "/tmp/opencode",
}

test("workspace wrap starts with bwrap and keeps original command after --", () => {
  const profile = builtInProfile("workspace", ctx)
  const wrapped = buildLinuxWrap({
    profile,
    class: "workspace-child",
    cwd: "/repo",
    command: "/bin/sh",
    args: ["-c", "echo hi"],
    bwrapPath: "/usr/bin/bwrap",
    deniedFiles: ["/repo/.env"],
    deniedDirs: [],
  })
  expect(wrapped.command).toBe("/usr/bin/bwrap")
  expect(wrapped.args.slice(0, 3)).toEqual(["--die-with-parent", "--unshare-pid", "--dev"])
  expect(wrapped.args).toContain("--ro-bind")
  expect(wrapped.args).not.toContain("--unshare-net")
  const dd = wrapped.args.indexOf("--")
  expect(wrapped.args.slice(dd)).toEqual(["--", "/bin/sh", "-c", "echo hi"])
  expect(wrapped.args).toContain("/repo/.env")
})

test("read-only workspace-child adds unshare-net; integration-child does not", () => {
  const profile = builtInProfile("read-only", ctx)
  const shell = buildLinuxWrap({
    profile,
    class: "workspace-child",
    cwd: "/repo",
    command: "/bin/sh",
    args: [],
    bwrapPath: "/usr/bin/bwrap",
    deniedFiles: [],
    deniedDirs: [],
  })
  const mcp = buildLinuxWrap({
    profile,
    class: "integration-child",
    cwd: "/repo",
    command: "npx",
    args: ["-y", "fake-mcp"],
    bwrapPath: "/usr/bin/bwrap",
    deniedFiles: [],
    deniedDirs: [],
  })
  expect(shell.args).toContain("--unshare-net")
  expect(mcp.args).not.toContain("--unshare-net")
})

test("strict omits ro-bind of /", () => {
  const profile = builtInProfile("strict", ctx)
  const wrapped = buildLinuxWrap({
    profile,
    class: "workspace-child",
    cwd: "/repo",
    command: "/bin/sh",
    args: [],
    bwrapPath: "/usr/bin/bwrap",
    deniedFiles: [],
    deniedDirs: [],
  })
  const binds: string[] = []
  for (let i = 0; i < wrapped.args.length; i++) {
    if (wrapped.args[i] === "--ro-bind") binds.push(wrapped.args[i + 1] ?? "")
  }
  expect(binds).not.toContain("/")
  expect(binds).toContain("/usr")
  expect(wrapped.args).toContain("--unshare-net")
  const tmpfs = wrapped.args.indexOf("--tmpfs")
  const firstBind = wrapped.args.indexOf("--bind")
  expect(tmpfs).toBeGreaterThan(-1)
  expect(wrapped.args[tmpfs + 1]).toBe("/tmp")
  expect(firstBind).toBeGreaterThan(tmpfs)
})

test("darwin profile text denies .env and optional network", () => {
  const profile = builtInProfile("read-only", ctx)
  const { command, args, seatbelt } = buildDarwinWrap({
    profile,
    class: "workspace-child",
    cwd: "/repo",
    command: "/bin/zsh",
    args: ["-l"],
  })
  expect(command).toBe("sandbox-exec")
  expect(seatbelt).toContain("(version 1)")
  expect(seatbelt).toContain("deny")
  expect(seatbelt).toMatch(/\\.env/)
  expect(seatbelt).toContain("(deny network*)")
  expect(args[0]).toBe("-p")
  expect(args.includes("--")).toBe(true)
})

test("windows non-off is Unsupported", () => {
  const err = windowsRefuse("workspace")
  expect(err._tag).toBe("Sandbox.Unsupported")
  expect(() => ensureBackend("workspace", "win32")).toThrow()
  try {
    ensureBackend("workspace", "win32")
  } catch (error) {
    expect((error as { _tag?: string })._tag).toBe("Sandbox.Unsupported")
  }
})

test("off wrapSpawn is identity", async () => {
  const wrapped = await wrapSpawn({
    class: "workspace-child",
    command: "/bin/sh",
    args: ["-c", "echo hi"],
    cwd: "/tmp",
    profileName: "off",
  })
  expect(wrapped).toEqual({ command: "/bin/sh", args: ["-c", "echo hi"] })
})

test("workspace wrapSpawn on linux prefixes bwrap", async () => {
  if (process.platform !== "linux") return
  const wrapped = await wrapSpawn({
    class: "workspace-child",
    command: "/bin/sh",
    args: ["-c", "echo hi"],
    cwd: "/tmp",
    profileName: "workspace",
    location: "/tmp",
    home: "/tmp",
  })
  expect(wrapped.command).toContain("bwrap")
  expect(wrapped.args.slice(0, 2)).toEqual(["--die-with-parent", "--unshare-pid"])
  const dd = wrapped.args.indexOf("--")
  expect(wrapped.args.slice(dd)).toEqual(["--", "/bin/sh", "-c", "echo hi"])
})

test("missing bwrap throws Unavailable", async () => {
  let thrown: { _tag?: string } | undefined
  try {
    await wrapSpawn({
      class: "workspace-child",
      command: "/bin/sh",
      args: [],
      cwd: "/tmp",
      profileName: "workspace",
      location: "/tmp",
      home: "/tmp",
      bwrapPath: "/no/bwrap",
      platform: "linux",
    })
  } catch (error) {
    thrown = error as { _tag?: string }
  }
  expect(thrown?._tag).toBe("Sandbox.Unavailable")
})

test("home-root .env is overlayed; location .env.example is not", async () => {
  if (process.platform !== "linux") return
  const home = await mkdtemp(path.join(tmpdir(), "oc-home-deny-"))
  const work = await mkdtemp(path.join(tmpdir(), "oc-work-deny-"))
  const secret = path.join(home, ".env")
  const example = path.join(work, ".env.example")
  try {
    await writeFile(secret, "SECRET=1\n")
    await writeFile(example, "EXAMPLE=1\n")
    const wrapped = await wrapSpawn({
      class: "workspace-child",
      command: "/bin/sh",
      args: ["-c", `cat '${example}'; cat '${secret}'`],
      cwd: work,
      profileName: "workspace",
      location: work,
      home,
    })
    const overlays: string[] = []
    for (let i = 0; i < wrapped.args.length; i++) {
      if (wrapped.args[i] === "--ro-bind" && wrapped.args[i + 1] === "/dev/null") overlays.push(wrapped.args[i + 2] ?? "")
    }
    expect(overlays).toContain(secret)
    expect(overlays).not.toContain(example)
    const proc = Bun.spawn([wrapped.command, ...wrapped.args], { stdout: "pipe", stderr: "pipe" })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    expect(code).not.toBe(0)
    expect(stdout).not.toContain("SECRET=1")
    expect(stdout).toContain("EXAMPLE=1")
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  }
})

test("win32 wrapSpawn workspace fails Unsupported without mocking platform globally", async () => {
  let thrown: { _tag?: string } | undefined
  try {
    await wrapSpawn({
      class: "workspace-child",
      command: "cmd.exe",
      args: ["/c", "echo hi"],
      cwd: "C:\\repo",
      profileName: "workspace",
      location: "C:\\repo",
      platform: "win32",
    })
  } catch (error) {
    thrown = error as { _tag?: string }
  }
  expect(thrown?._tag).toBe("Sandbox.Unsupported")
})
