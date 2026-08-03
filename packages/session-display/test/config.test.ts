import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG, mergeConfig } from "../src/config"

describe("mergeConfig display flags", () => {
  test("dimDetails defaults true (Grok ToolConfig default)", () => {
    expect(DEFAULT_CONFIG.dimDetails).toBe(true)
  })

  test("mergeConfig accepts dimDetails", () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, { dimDetails: false })
    expect(cfg.dimDetails).toBe(false)
  })

  test("unknown keys ignored", () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, { dimDetails: false, bogus: 42 })
    expect(cfg.dimDetails).toBe(false)
    expect((cfg as unknown as Record<string, unknown>).bogus).toBeUndefined()
  })
})
