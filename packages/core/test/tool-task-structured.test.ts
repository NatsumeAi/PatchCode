import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { TaskTool } from "../src/tool/task"

describe("TaskTool structured result contract", () => {
  test("Output schema accepts structured exit states", () => {
    for (const exit of ["running", "completed", "failed", "cancelled", "timeout", "budget_exhausted"] as const) {
      const decoded = Schema.decodeUnknownSync(TaskTool.Output)({
        title: "t",
        output: "o",
        structured: { exit, resumeFrom: "ses_child" },
      })
      expect(decoded.structured?.exit).toBe(exit)
    }
  })

  test("Output schema stays backward compatible without structured", () => {
    const decoded = Schema.decodeUnknownSync(TaskTool.Output)({ title: "t", output: "o" })
    expect(decoded.structured).toBeUndefined()
  })

  test("Output schema rejects unknown exit state", () => {
    expect(() =>
      Schema.decodeUnknownSync(TaskTool.Output)({
        title: "t",
        output: "o",
        structured: { exit: "done" },
      }),
    ).toThrow()
  })

  test("structured carries turns and usage", () => {
    const decoded = Schema.decodeUnknownSync(TaskTool.Output)({
      title: "t",
      output: "o",
      structured: { exit: "completed", turns: 12, usage: { input: 100, output: 50, cost: 0.01 }, resumeFrom: "ses_child" },
    })
    expect(decoded.structured?.turns).toBe(12)
    expect(decoded.structured?.usage?.cost).toBe(0.01)
  })

  test("host fills turns/usage from assistant messages (contract)", () => {
    // tool-host-bridges foreground completion sets:
    //   turns: record?.turnCount ?? assistants.length
    //   usage: { input, output, cost } summed from assistant tokens/cost
    // This schema round-trip locks the wire shape those fields must satisfy.
    const filled = Schema.decodeUnknownSync(TaskTool.Output)({
      title: "explore",
      output: "done",
      task_id: "ses_child",
      sessionID: "ses_child",
      background: false,
      structured: {
        exit: "completed",
        turns: 2,
        usage: { input: 10, output: 20, cost: 0 },
        resumeFrom: "ses_child",
      },
    })
    expect(filled.structured?.turns).toBe(2)
    expect(filled.structured?.usage).toEqual({ input: 10, output: 20, cost: 0 })
  })
})
