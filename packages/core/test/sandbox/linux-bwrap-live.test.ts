import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const bwrap = "/usr/bin/bwrap"

function run(args: string[]) {
  return new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(bwrap, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += String(c)))
    child.stderr.on("data", (c) => (stderr += String(c)))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

describe.skipIf(process.platform !== "linux")("bwrap kernel probe", () => {
  test("binary exists — missing bwrap is a hard fail on linux", async () => {
    const stat = await Bun.file(bwrap).exists()
    expect(stat).toBe(true)
  })

  test("write outside bind is EROFS and does not create the host file", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "oc-sb-work-"))
    const outside = await mkdtemp(path.join(tmpdir(), "oc-sb-out-"))
    const leaked = path.join(outside, "leaked.txt")
    try {
      const result = await run([
        "--die-with-parent",
        "--unshare-pid",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        work,
        work,
        "--chdir",
        work,
        "--",
        "/bin/sh",
        "-c",
        `echo leaked > '${leaked}'`,
      ])
      expect(result.code).not.toBe(0)
      expect(result.stderr + result.stdout).toMatch(/Read-only file system|Permission denied|权限不够/i)
      expect(await Bun.file(leaked).exists()).toBe(false)
    } finally {
      await rm(work, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("denied file bind-over is unreadable", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "oc-sb-den-"))
    try {
      await writeFile(path.join(work, "secret.env"), "SECRET\n")
      const result = await run([
        "--die-with-parent",
        "--unshare-pid",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        work,
        work,
        "--ro-bind",
        "/dev/null",
        path.join(work, "secret.env"),
        "--chdir",
        work,
        "--",
        "/bin/cat",
        "secret.env",
      ])
      expect(result.code).not.toBe(0)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  test("unshare-net makes TCP ENETUNREACH", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "oc-sb-net-"))
    try {
      const result = await run([
        "--die-with-parent",
        "--unshare-pid",
        "--unshare-net",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--ro-bind",
        "/",
        "/",
        "--bind",
        work,
        work,
        "--chdir",
        work,
        "--",
        "python3",
        "-c",
        "import socket; s=socket.socket(); s.settimeout(1); s.connect(('1.1.1.1', 53))",
      ])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/Network is unreachable|Errno 101/)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })
})
