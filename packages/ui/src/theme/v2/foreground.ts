import { blend, contrastRatio, hexToOklch, shift } from "../color"
import { mapKitSemantics } from "./mapping"
import type { ColorValue, HexColor, KitColorValue } from "../types"

const GREY_STEPS = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200] as const

const greyRef = (step: number): KitColorValue => `var(--kit-grey-${step})`

function greyHex(primitives: Record<string, KitColorValue>, step: number) {
  const hex = primitives[`kit-grey-${step}`]
  if (typeof hex === "string" && hex.startsWith("#")) return hex as HexColor
}

function resolveGreyRef(value: KitColorValue, primitives: Record<string, KitColorValue>) {
  const step = value.match(/^var\(--kit-grey-(\d+)\)$/)?.[1]
  if (!step) throw new Error(`Expected grey primitive ref, got ${value}`)
  const hex = greyHex(primitives, Number(step))
  if (!hex) throw new Error(`Missing grey primitive kit-grey-${step}`)
  return hex
}

function pickGrey(primitives: Record<string, KitColorValue>, background: HexColor, minContrast: number, target: number) {
  const matches = GREY_STEPS.filter((step) => {
    const hex = greyHex(primitives, step)
    return hex && contrastRatio(hex, background) >= minContrast
  })
  if (matches.length === 0) return target
  return matches.reduce((best, step) => (Math.abs(step - target) < Math.abs(best - target) ? step : best))
}

export function mapKitForeground(
  ink: HexColor,
  isDark: boolean,
  primitives: Record<string, KitColorValue>,
  overrides: Record<string, ColorValue> = {},
): Record<string, KitColorValue> {
  const tint = hexToOklch(ink)
  const body = shift(ink, {
    l: isDark ? Math.max(0, 0.88 - tint.l) * 0.4 : -Math.max(0, tint.l - 0.18) * 0.24,
    c: isDark ? 1.04 : 1.02,
  })

  const semantics = mapKitSemantics(isDark)
  const bgBase = resolveGreyRef(semantics["kit-background-bg-base"], primitives)
  const bgContrast = resolveGreyRef(semantics["kit-background-bg-contrast"], primitives)
  const bgInverse = resolveGreyRef(semantics["kit-background-bg-inverse"], primitives)
  const inverseTarget = hexToOklch(bgInverse).l > 0.55 ? 1100 : greyHex(primitives, 50) ? 50 : 100

  return {
    "kit-text-text-base": isDark ? blend("#ffffff", body, 0.9) : shift(body, { l: -0.07, c: 1.04 }),
    "kit-text-text-muted": overrides["text-weak"] ?? shift(body, { l: isDark ? -0.11 : 0.11, c: 0.9 }),
    "kit-text-text-faint": shift(body, { l: isDark ? -0.2 : 0.21, c: isDark ? 0.78 : 0.72 }),
    "kit-icon-icon-base": greyRef(pickGrey(primitives, bgBase, 7, isDark ? 400 : 800)),
    "kit-icon-icon-muted": greyRef(pickGrey(primitives, bgBase, 3, 600)),
    "kit-icon-icon-inverse": greyRef(pickGrey(primitives, bgInverse, 7, inverseTarget)),
    "kit-icon-icon-contrast": greyRef(pickGrey(primitives, bgContrast, 7, 100)),
    "kit-icon-icon-accent": isDark ? "var(--kit-blue-400)" : "var(--kit-blue-600)",
    "kit-icon-icon-accent-hover": isDark ? "var(--kit-blue-300)" : "var(--kit-blue-700)",
  }
}
