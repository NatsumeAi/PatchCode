import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const coreSrc = path.resolve(import.meta.dir, "../../src")

describe("W7 inventory", () => {
  test("step-ratio constants are gone", () => {
    const engine = fs.readFileSync(path.join(coreSrc, "session/runner/context-engine.ts"), "utf8")
    expect(engine).not.toContain("PROACTIVE_COMPACT_RATIO")
    expect(engine).not.toContain("MIN_STEPS_BETWEEN_PROACTIVE_COMPACT")
    const src = fs.readFileSync(path.join(coreSrc, "session/runner/llm.ts"), "utf8")
    expect(src).toContain("setUsage")
    const session = fs.readFileSync(path.join(coreSrc, "session.ts"), "utf8")
    expect(session).toContain("uncompact")
    const fn = session.slice(session.indexOf("uncompact: Effect.fn"))
    const body = fn.slice(0, fn.indexOf("wait: Effect.fn"))
    expect(body).not.toContain(".prompt(")
    expect(body).not.toContain("resetForDrain")
    expect(body).toContain("CompactionCheckpoint.restore")
    const compact = fs.readFileSync(path.join(coreSrc, "session/compaction.ts"), "utf8")
    expect(compact).toContain("Compaction.Checkpoint")
    expect(compact).toContain("CompactionCheckpoint.write")
  })
})
