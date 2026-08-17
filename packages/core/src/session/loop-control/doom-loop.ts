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
 * Stable fingerprint for a tool call: name + sorted JSON of args.
 * Used so parallel same-name tools with different args do not doom-loop,
 * while true retry loops (same name+args) still trip the detector.
 */
export function toolFingerprint(name: string, input?: unknown): string {
  return `${name}:${stableArgsHash(input)}`
}

function stableArgsHash(input: unknown): string {
  if (input === undefined || input === null) return ""
  try {
    return JSON.stringify(input, (_key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>
        const sorted: Record<string, unknown> = {}
        for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
        return sorted
      }
      return value
    })
  } catch {
    return String(input)
  }
}

/**
 * Detect repeated identical tool call fingerprints (name + stable args hash).
 */
/** Official leftover processor: ask doom_loop permission after this many identical tool calls. */
export const ASK_THRESHOLD = 3
/** Live HardAbort after this many identical fingerprints (stronger than official ask). */
export const HARD_ABORT_THRESHOLD = 8

export function detectRepeatedToolFingerprint(
  recentFingerprints: readonly string[],
  /** High enough that short parallel batches of same name+args can complete; true loops still trip. */
  threshold = HARD_ABORT_THRESHOLD,
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
