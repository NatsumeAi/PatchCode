import { describe, expect, test } from "bun:test"
import { nextFoldMode } from "../src/fold"

describe("nextFoldMode", () => {
  test("two-state: collapsed → expanded → collapsed", () => {
    expect(nextFoldMode("two", "collapsed", false)).toBe("expanded")
    expect(nextFoldMode("two", "expanded", false)).toBe("collapsed")
    expect(nextFoldMode("two", "truncated", false)).toBe("collapsed")
  })

  test("three-state (read): collapsed → truncated → expanded → collapsed", () => {
    expect(nextFoldMode("three", "collapsed", false)).toBe("truncated")
    expect(nextFoldMode("three", "truncated", false)).toBe("expanded")
    expect(nextFoldMode("three", "expanded", false)).toBe("collapsed")
  })

  test("three-state running flag is ignored (Grok read next_fold ignores _is_running)", () => {
    expect(nextFoldMode("three", "collapsed", true)).toBe("truncated")
    expect(nextFoldMode("three", "truncated", true)).toBe("expanded")
    expect(nextFoldMode("three", "collapsed", false)).toBe("truncated")
  })
})

