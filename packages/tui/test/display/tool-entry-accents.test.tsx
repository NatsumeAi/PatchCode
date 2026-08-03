import { describe, expect, test } from "bun:test"
import type { RGBA } from "@opentui/core"
import type { ToolViewModel } from "@opencode-ai/session-display"
import { statusColor } from "../../src/display/ToolEntry"

const theme = {
  error: { r: 255, g: 0, b: 0, a: 1 } as RGBA,
  warning: { r: 255, g: 165, b: 0, a: 1 } as RGBA,
  success: { r: 0, g: 200, b: 0, a: 1 } as RGBA,
  text: { r: 220, g: 220, b: 220, a: 1 } as RGBA,
  textMuted: { r: 120, g: 120, b: 120, a: 1 } as RGBA,
}

function vm(overrides: Partial<ToolViewModel> = {}): ToolViewModel {
  return {
    mode: "collapsed",
    header: {
      verb: "Read",
      icon: "\u2192",
      family: "read",
      primary: "src/foo.ts",
      details: "",
      muted: false,
      dimDetails: true,
      status: "completed",
      accent: "read",
    },
    body: { kind: "none" },
    userPinned: false,
    clickable: true,
    chrome: "inline",
    ...overrides,
  }
}

describe("statusColor (Grok colors by status, not tool name)", () => {
  test("error status → error accent", () => {
    const c = statusColor("error", "shell", false, theme as never)
    expect(c).toBe(theme.error)
  })

  test("accent error wins even when completed", () => {
    const c = statusColor("completed", "error", false, theme as never)
    expect(c).toBe(theme.error)
  })

  test("running → warning (Grok accent_running)", () => {
    const c = statusColor("running", "shell", false, theme as never)
    expect(c).toBe(theme.warning)
  })

  test("muted collapsed → textMuted", () => {
    const c = statusColor("completed", "read", true, theme as never)
    expect(c).toBe(theme.textMuted)
  })

  test("success accent → success color", () => {
    const c = statusColor("completed", "success", false, theme as never)
    expect(c).toBe(theme.success)
  })

  test("default completed → text", () => {
    const c = statusColor("completed", "read", false, theme as never)
    expect(c).toBe(theme.text)
  })
})

describe("ToolViewModel contract for accent rendering", () => {
  test("error status maps to error accent", () => {
    const v = vm({ header: { ...vm().header, status: "error" } })
    expect(v.header.status).toBe("error")
  })
  test("running maps to warning accent (Grok accent_running)", () => {
    const v = vm({ header: { ...vm().header, status: "running" } })
    expect(v.header.status).toBe("running")
  })
  test("completed+success accent maps success", () => {
    const v = vm({ header: { ...vm().header, status: "completed", accent: "success" } })
    expect(v.header.accent).toBe("success")
  })
  test("muted collapsed maps muted", () => {
    const v = vm({ header: { ...vm().header, muted: true } })
    expect(v.header.muted).toBe(true)
  })
  test("dimDetails flag flows from view model", () => {
    const v = vm({ header: { ...vm().header, details: "(1-50)", dimDetails: true } })
    expect(v.header.details).toBe("(1-50)")
    expect(v.header.dimDetails).toBe(true)
  })
  test("collapsed clickable entry is groupable (gap=0 rule precondition)", () => {
    const v = vm({ mode: "collapsed" })
    expect(v.mode).toBe("collapsed")
    expect(v.clickable).toBe(true)
  })
})
