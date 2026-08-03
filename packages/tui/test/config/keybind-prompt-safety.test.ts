import { describe, expect, test } from "bun:test"
import { TuiKeybind } from "../../src/config/keybind"

/**
 * Regression: fold shortcuts must never ship as bare printable keys.
 * Bare e/h/l/E stole prompt typing; the feature was never user-requested.
 */
describe("keybind prompt-safety defaults", () => {
  const defs = TuiKeybind.Definitions

  test("fold shortcuts default to none (no bare e/h/l/E)", () => {
    expect(defs.session_fold_toggle.default).toBe("none")
    expect(defs.session_fold_collapse.default).toBe("none")
    expect(defs.session_fold_expand.default).toBe("none")
    expect(defs.session_expand_all.default).toBe("none")
    expect(defs.session_expand_all_thinking.default).toBe("none")
  })
})
