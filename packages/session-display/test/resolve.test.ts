import { describe, expect, test } from "bun:test"
import { resolveMode, type DisplayPolicy, type ResolveModeInput } from "../src/mode"

const basePolicy: DisplayPolicy = {
  streaming: "collapsed",
  finished: "collapsed",
  error: "truncated",
  foldable: true,
}

describe("resolveMode §8.1 matrix", () => {
  test("running → streaming", () => {
    const result = resolveMode({ policy: basePolicy, status: "running", userPin: null })
    expect(result).toBe("collapsed")
  })

  test("completed, finished=collapsed → collapsed", () => {
    const result = resolveMode({ policy: basePolicy, status: "completed", userPin: null })
    expect(result).toBe("collapsed")
  })

  test("completed, finished=expanded → expanded", () => {
    const policy: DisplayPolicy = { ...basePolicy, finished: "expanded" }
    const result = resolveMode({ policy, status: "completed", userPin: null })
    expect(result).toBe("expanded")
  })

  test("completed, finished=keep → streaming (fallback)", () => {
    const policy: DisplayPolicy = { ...basePolicy, finished: "keep" }
    const result = resolveMode({ policy, status: "completed", userPin: null })
    expect(result).toBe("collapsed")
  })

  test("completed + logicalError → error policy", () => {
    const result = resolveMode({ policy: basePolicy, status: "completed", userPin: null, logicalError: true })
    expect(result).toBe("truncated")
  })

  test("error status → error policy", () => {
    const result = resolveMode({ policy: basePolicy, status: "error", userPin: null })
    expect(result).toBe("truncated")
  })

  test("pin overrides everything", () => {
    const result = resolveMode({ policy: basePolicy, status: "completed", userPin: "expanded" })
    expect(result).toBe("expanded")
  })

  test("pending → streaming", () => {
    const result = resolveMode({ policy: basePolicy, status: "pending", userPin: null })
    expect(result).toBe("collapsed")
  })

  test("pin wins over error", () => {
    const result = resolveMode({ policy: basePolicy, status: "error", userPin: "collapsed" })
    expect(result).toBe("collapsed")
  })

  test("completed with finished=expanded and no pin → expanded (Grok read stays collapsed only via its own finished)", () => {
    const policy: DisplayPolicy = { ...basePolicy, finished: "expanded" }
    const result = resolveMode({ policy, status: "completed", userPin: null })
    expect(result).toBe("expanded")
  })

  test("pinned collapsed + completed + finished=expanded → pin wins (respect_manual_folds)", () => {
    const policy: DisplayPolicy = { ...basePolicy, finished: "expanded" }
    const result = resolveMode({ policy, status: "completed", userPin: "collapsed" })
    expect(result).toBe("collapsed")
  })

  test("pinned expanded + running → pin wins (Grok: manual fold survives finish and stream)", () => {
    const policy: DisplayPolicy = { ...basePolicy, streaming: "collapsed", finished: "collapsed" }
    const result = resolveMode({ policy, status: "running", userPin: "expanded" })
    expect(result).toBe("expanded")
  })
})
