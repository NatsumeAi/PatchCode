import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { inProcessFromPlugin } from "@/plugin/hooks-bridge"

describe("plugin hooks bridge", () => {
  test("tool.execute.before deny throws and blocks PreToolUse", async () => {
    const handlers = inProcessFromPlugin(
      {
        "tool.execute.before": async () => {
          throw new Error("nope")
        },
      },
      0,
    )
    const pre = handlers.find((item) => item.event === "PreToolUse")
    expect(pre).toBeDefined()
    const decision = await Effect.runPromise(
      pre!.run({
        hookEventName: "PreToolUse",
        sessionId: "ses_1",
        cwd: "/tmp",
        toolName: "write",
        toolInput: { path: "x" },
        toolInputTruncated: false,
        timestamp: new Date().toISOString(),
      }),
    )
    expect(decision).toEqual({ _tag: "Deny", reason: "hook_failed", hookId: "plugin:0:PreToolUse" })
  })

  test("tool.execute.before allow continues", async () => {
    const handlers = inProcessFromPlugin(
      {
        "tool.execute.before": async () => {},
      },
      1,
    )
    const pre = handlers.find((item) => item.event === "PreToolUse")
    const decision = await Effect.runPromise(
      pre!.run({
        hookEventName: "PreToolUse",
        sessionId: "ses_1",
        cwd: "/tmp",
        toolName: "bash",
        toolInput: { command: "true" },
        toolInputTruncated: false,
        timestamp: new Date().toISOString(),
      }),
    )
    expect(decision).toEqual({ _tag: "Allow" })
  })
})
