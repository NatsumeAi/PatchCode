import { describe, expect, test } from "bun:test"
import { parseStdout, runCommand } from "@opencode-ai/core/hooks"
import type { CommandHook, Envelope } from "@opencode-ai/core/hooks/schema"

const envelope: Envelope = {
  hookEventName: "PreToolUse",
  sessionId: "ses_hook",
  cwd: process.cwd(),
  toolName: "bash",
  timestamp: new Date().toISOString(),
}

const hook = (command: string, timeout = 5): CommandHook => ({
  type: "command",
  command,
  timeout,
  specDir: "/",
})

describe("W5 run-command", () => {
  test("deny JSON", async () => {
    const decision = await runCommand({
      hook: hook(`echo '{"decision":"deny","reason":"x"}'`),
      envelope,
      origin: "global",
      cwd: process.cwd(),
      hookId: "g:deny",
    })
    expect(decision._tag).toBe("Deny")
    if (decision._tag === "Deny") expect(decision.reason).toBe("x")
  })

  test("exit 2 is deny", async () => {
    const decision = await runCommand({
      hook: hook("exit 2"),
      envelope,
      origin: "global",
      cwd: process.cwd(),
      hookId: "g:exit2",
    })
    expect(decision._tag).toBe("Deny")
  })

  test("allow JSON", async () => {
    const decision = await runCommand({
      hook: hook(`echo '{"decision":"allow"}'`),
      envelope,
      origin: "global",
      cwd: process.cwd(),
      hookId: "g:allow",
    })
    expect(decision._tag).toBe("Allow")
  })

  test("timeout is deny hook_failed not allow", async () => {
    const decision = await runCommand({
      hook: hook("sleep 10", 1),
      envelope,
      origin: "global",
      cwd: process.cwd(),
      hookId: "g:timeout",
    })
    expect(decision).toEqual({ _tag: "Deny", reason: "hook_failed", hookId: "g:timeout" })
  })

  test("partial JSON on PreToolUse is deny", () => {
    expect(parseStdout("{not json", 0, false, "g:bad")).toEqual({
      _tag: "Deny",
      reason: "hook_failed",
      hookId: "g:bad",
    })
  })
})
