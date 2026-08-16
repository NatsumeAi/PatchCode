import { describe, expect, test } from "bun:test"
import { TuiKeybind } from "../../src/config/keybind"

describe("job_promote keybind", () => {
  const defs = TuiKeybind.Definitions

  test("messages_first still includes ctrl+g", () => {
    expect(String(defs.messages_first.default)).toContain("ctrl+g")
  })

  test("job_promote is bound to an unused chord, not ctrl+g or ctrl+b", () => {
    const chord = String(defs.job_promote.default)
    expect(chord).not.toContain("ctrl+g")
    expect(chord).not.toContain("ctrl+b")
    expect(chord).toBe("ctrl+shift+j")
    expect(TuiKeybind.CommandMap.job_promote).toBe("job.promote")
  })
})
