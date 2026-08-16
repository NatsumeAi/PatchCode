import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const coreSrc = path.resolve(import.meta.dir, "../../src")

describe("W8b inventory", () => {
  test("bash execute calls PlanGate after decide", () => {
    const text = fs.readFileSync(path.join(coreSrc, "tool/bash.ts"), "utf8")
    expect(text).toContain("PlanGate.assertMutation")
    const decide = text.indexOf("execPolicy.decideCommand")
    const gate = text.indexOf("PlanGate.assertMutation")
    const wrap = text.indexOf("sandbox.wrapSpawn")
    expect(gate).toBeGreaterThan(decide)
    expect(wrap).toBeGreaterThan(gate)
  })

  test("write edit apply-patch call PlanGate", () => {
    for (const file of ["tool/write.ts", "tool/edit.ts", "tool/apply-patch.ts"]) {
      expect(fs.readFileSync(path.join(coreSrc, file), "utf8")).toContain("PlanGate.assertMutation")
    }
  })
})
