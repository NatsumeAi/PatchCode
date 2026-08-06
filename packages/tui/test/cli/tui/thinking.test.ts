import { describe, expect, test } from "bun:test"
import {
  nextThinkingMode,
  nextThinkingPreference,
  reasoningSummary,
  thinkingPreferenceActionTitle,
} from "../../../src/context/thinking"

describe("reasoningSummary", () => {
  test("extracts a leading summary title and leaves markdown body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\nDetails.\n\n**Next section**\n\nMore.")).toEqual({
      title: "Continuing Quality Review",
      body: "Details.\n\n**Next section**\n\nMore.",
    })
  })

  test("extracts a completed title before its streamed body arrives", () => {
    expect(reasoningSummary("**Continuing Quality Review**")).toEqual({
      title: "Continuing Quality Review",
      body: "",
    })
  })

  test("preserves markdown-significant indentation in the extracted body", () => {
    expect(reasoningSummary("**Continuing Quality Review**\n\n    const value = true\n")).toEqual({
      title: "Continuing Quality Review",
      body: "    const value = true",
    })
  })

  test("does not consume ordinary leading bold content", () => {
    expect(reasoningSummary("**Important:** keep this in the body.")).toEqual({
      title: null,
      body: "**Important:** keep this in the body.",
    })
  })

  test("leaves content without a leading title in its body", () => {
    expect(reasoningSummary("Details only.")).toEqual({ title: null, body: "Details only." })
  })
})

describe("thinking preference cycle (auto lifecycle)", () => {
  test("auto → show → hide → auto", () => {
    expect(nextThinkingPreference(null)).toBe("show")
    expect(nextThinkingPreference("show")).toBe("hide")
    expect(nextThinkingPreference("hide")).toBe(null)
  })

  test("legacy nextThinkingMode still flips show↔hide", () => {
    expect(nextThinkingMode("show")).toBe("hide")
    expect(nextThinkingMode("hide")).toBe("show")
  })

  test("action titles describe the next preference", () => {
    expect(thinkingPreferenceActionTitle(null)).toBe("Always expand thinking")
    expect(thinkingPreferenceActionTitle("show")).toBe("Always collapse thinking")
    expect(thinkingPreferenceActionTitle("hide")).toBe("Auto-fold thinking")
  })

  test("footgun lock: must not treat unset as show when cycling", () => {
    expect(nextThinkingPreference(null)).not.toBe("hide")
  })
})
