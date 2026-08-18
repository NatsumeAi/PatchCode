import { describe, expect, test } from "bun:test"
import { resolveKitThemeVariant, themeKitToCss } from "./resolve"
import type { ThemeVariant } from "../types"

const palette = {
  neutral: "#f7f7f7",
  ink: "#171311",
  primary: "#dcde8d",
  success: "#12c905",
  warning: "#ffdc17",
  error: "#fc533a",
  info: "#a753ae",
  interactive: "#034cff",
} as const

describe("resolveKitThemeVariant", () => {
  test("kitOverrides win on canonical kit-* keys", () => {
    const variant: ThemeVariant = {
      palette,
      kitOverrides: { "kit-grey-50": "#aabbccff" },
    }
    const tokens = resolveKitThemeVariant(variant, false)
    expect(tokens["kit-grey-50"]).toBe("#aabbccff")
    expect(tokens["v2-grey-50"]).toBeUndefined()
  })

  test("reads deprecated v2Overrides and remaps v2-* keys one-way", () => {
    const variant: ThemeVariant = {
      palette,
      v2Overrides: {
        "v2-grey-50": "#112233ff",
        "v2-text-text-accent": "var(--v2-blue-700)",
      },
    }
    const tokens = resolveKitThemeVariant(variant, false)
    expect(tokens["kit-grey-50"]).toBe("#112233ff")
    expect(tokens["kit-text-text-accent"]).toBe("var(--kit-blue-700)")
    expect(tokens["v2-grey-50"]).toBeUndefined()
  })
})

describe("themeKitToCss", () => {
  test("emits --kit-* declarations and --v2-* aliases", () => {
    const css = themeKitToCss({ "kit-grey-50": "#ffffffff" })
    expect(css).toContain("--kit-grey-50: #ffffffff;")
    expect(css).toContain("--v2-grey-50: var(--kit-grey-50);")
  })
})
