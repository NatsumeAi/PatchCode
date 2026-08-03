import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { blendColor, waveBrightness } from "../../src/display/accent-wave"

describe("waveBrightness (Grok tokyonight.rs)", () => {
  test("bounded 0..1", () => {
    for (let t = 0; t < 100; t += 7) {
      const b = waveBrightness(t, 0)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(1)
    }
  })

  test("row phase shifts", () => {
    expect(waveBrightness(0, 8, 32, 0.15)).not.toBe(waveBrightness(0, 0, 32, 0.15))
  })
})

describe("blendColor", () => {
  test("brightness 1 → full accent", () => {
    const out = blendColor(RGBA.fromInts(0, 0, 0), RGBA.fromInts(255, 0, 0), 1)
    expect(out.toInts()[0]).toBe(255)
  })

  test("brightness 0 → full base", () => {
    const out = blendColor(RGBA.fromInts(10, 20, 30), RGBA.fromInts(255, 0, 0), 0)
    expect(out.toInts()[0]).toBe(10)
  })

  test("brightness 0.5 → midpoint", () => {
    const out = blendColor(RGBA.fromInts(0, 0, 0), RGBA.fromInts(100, 0, 0), 0.5)
    expect(out.toInts()[0]).toBe(50)
  })
})
