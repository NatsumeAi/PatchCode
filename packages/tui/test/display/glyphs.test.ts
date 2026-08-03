import { describe, expect, test } from "bun:test"
import { diamondFilled, disclosureClosed, disclosureOpen } from "../../src/display/glyphs"

describe("glyphs", () => {
  test("single disclosure family: > closed, v open", () => {
    expect(disclosureClosed).toBe(">")
    expect(disclosureOpen).toBe("v")
    // legacy alias also points at >
    expect(diamondFilled).toBe(">")
  })
})

