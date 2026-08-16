export * as HooksRunCommand from "./run-command"

import { spawn } from "node:child_process"
import path from "node:path"
import { wrapSpawn } from "../sandbox/wrap-spawn"
import type { CommandHook, Decision, Envelope, Origin } from "./schema"

const MAX_STDOUT = 64 * 1024
const META = /[;&|`$<>(){}\n]/

const argvFor = (hook: CommandHook) => {
  if (META.test(hook.command)) return { command: "/bin/sh", args: ["-c", hook.command] }
  const resolved = path.isAbsolute(hook.command) ? hook.command : path.join(hook.specDir, hook.command)
  return { command: resolved, args: [] as string[] }
}

export const parseStdout = (stdout: string, exit: number, timedOut: boolean, hookId: string): Decision => {
  if (timedOut) return { _tag: "Deny", reason: "hook_failed", hookId }
  if (exit === 2) return { _tag: "Deny", reason: "denied", hookId }
  const trimmed = stdout.trim()
  if (exit === 0 && trimmed.length === 0) return { _tag: "Allow" }
  try {
    const parsed = JSON.parse(trimmed) as { decision?: string; reason?: string }
    if (parsed.decision === "allow") return { _tag: "Allow" }
    if (parsed.decision === "deny") return { _tag: "Deny", reason: parsed.reason || "denied", hookId }
  } catch {
    // invalid JSON
  }
  if (exit === 0 && trimmed.length > 0) return { _tag: "Deny", reason: "hook_failed", hookId }
  return { _tag: "Deny", reason: "hook_failed", hookId }
}

export const runCommand = async (input: {
  hook: CommandHook
  envelope: Envelope
  origin: Origin
  cwd: string
  hookId: string
  sessionID?: string
}): Promise<Decision> => {
  const timeoutMs = Math.max(1, input.hook.timeout) * 1000
  let argv = argvFor(input.hook)
  if (input.origin === "project") {
    const wrapped = await wrapSpawn({
      class: "workspace-child",
      command: argv.command,
      args: argv.args,
      cwd: input.cwd,
      whenUnpinned: "location",
      location: input.cwd,
    })
    argv = { command: wrapped.command, args: wrapped.args }
  }
  return await new Promise((resolve) => {
    const child = spawn(argv.command, argv.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    })
    let stdout = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, timeoutMs)
    child.stdin.write(JSON.stringify(input.envelope))
    child.stdin.end()
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_STDOUT) stdout += String(chunk).slice(0, MAX_STDOUT - stdout.length)
    })
    child.stderr.resume()
    child.on("error", () => {
      clearTimeout(timer)
      resolve({ _tag: "Deny", reason: "hook_failed", hookId: input.hookId })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve(parseStdout(stdout, code ?? 1, timedOut, input.hookId))
    })
  })
}
