import { RGBA } from "@opentui/core"

/** sin² traveling wave across rows — Grok theme/tokyonight.rs:305. */
export function waveBrightness(tick: number, row: number, waveRows = 32, speed = 0.15): number {
  const rowsPerWave = Math.max(1, waveRows)
  const phase = (row / rowsPerWave) * 2 * Math.PI
  const t = tick * speed
  const sinVal = Math.sin(t + phase)
  return sinVal * sinVal
}

/** Linear RGB lerp toward base — Grok render/color.rs blend_channel.
 * RGBA getters are normalized 0..1; fromInts expects 0..255. */
export function blendColor(base: RGBA, accent: RGBA, brightness: number): RGBA {
  const lerp = (b: number, a: number) => b * (1 - brightness) + a * brightness
  return RGBA.fromInts(
    Math.round(lerp(base.r, accent.r) * 255),
    Math.round(lerp(base.g, accent.g) * 255),
    Math.round(lerp(base.b, accent.b) * 255),
  )
}
