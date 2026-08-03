import { describe, expect, test } from "bun:test"
import { accentBar, collapsedAccent, diamondFilled, disclosureClosed, disclosureOpen } from "../../src/display/glyphs"

describe("glyphs", () => {
  test("accent bar is heavy vertical (Grok accent_bar)", () => {
    expect(accentBar).toBe("\u2503")
  })
  test("collapsed accent is medium vertical bar (Grok collapsed_accent)", () => {
    expect(collapsedAccent).toBe("\u2759")
  })
  test("diamond filled bullet", () => {
    expect(diamondFilled).toBe("\u25C6")
  })
  test("disclosure pairs", () => {
    expect(disclosureOpen).toBe("\u25BE")
    expect(disclosureClosed).toBe("\u25B8")
  })
})
