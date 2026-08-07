export * as DoomLoop from "./doom-loop"

import { Schema } from "effect"

export const DoomLoopSignalKind = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("TailRepetition"), count: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("LowLogprob") }),
  Schema.Struct({ kind: Schema.Literal("Unknown"), reason: Schema.String }),
])
export type DoomLoopSignalKind = Schema.Schema.Type<typeof DoomLoopSignalKind>

export const DoomLoopSignal = Schema.Struct({
  channel: Schema.String,
  signal: DoomLoopSignalKind,
})
export type DoomLoopSignal = Schema.Schema.Type<typeof DoomLoopSignal>

/** Normalize assistant text for tail-repetition detection. */
export function normalizeClaim(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase()
}

/**
 * Detect doom-loop from recent assistant claims.
 * Returns a signal when the last `threshold` non-empty claims are identical after normalize.
 */
export function detectTailRepetition(
  recentClaims: readonly string[],
  threshold = 3,
): DoomLoopSignal | undefined {
  if (recentClaims.length < threshold) return undefined
  const tail = recentClaims.slice(-threshold).map(normalizeClaim).filter((s) => s.length > 0)
  if (tail.length < threshold) return undefined
  const first = tail[0]!
  if (first.length < 8) return undefined
  if (!tail.every((s) => s === first)) return undefined
  return {
    channel: "assistant_claim",
    signal: { kind: "TailRepetition", count: threshold },
  }
}

/**
 * Detect repeated identical tool call fingerprints (name + stable args hash).
 */
export function detectRepeatedToolFingerprint(
  recentFingerprints: readonly string[],
  /** High default: parallel tool batches of the same name are normal. */
  threshold = 12,
): DoomLoopSignal | undefined {
  if (recentFingerprints.length < threshold) return undefined
  const tail = recentFingerprints.slice(-threshold)
  const first = tail[0]
  if (!first || !tail.every((s) => s === first)) return undefined
  return {
    channel: "tool_call",
    signal: { kind: "TailRepetition", count: threshold },
  }
}
