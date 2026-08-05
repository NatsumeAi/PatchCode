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
})
