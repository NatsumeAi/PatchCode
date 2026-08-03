import type { ReasoningPart } from "@opencode-ai/sdk/v2"
import type { DisplayConfig } from "../config"
import type { DisplayMode } from "../mode"

export interface ReasoningViewModel {
  mode: DisplayMode
  title: string | null
  body: string
  durationMs: number | null
  userPinned: boolean
  status: "streaming" | "done"
}

/**
 * Extract reasoning summary title from markdown content.
 * Matches OpenAI pattern: "**Title**\n\nbody"
 */
export function reasoningSummary(text: string): { title: string | null; body: string } {
  const content = text.trim()
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  if (!match) return { title: null, body: content }
  return { title: match[1].trim(), body: content.slice(match[0].length).trimEnd() }
}

/**
 * Resolve reasoning display mode per §3.7:
 * - New user (storedMode=null): streaming→truncated, done→collapsed
 * - kv "hide": always collapsed (header visible, body on pin/click only)
 * - kv "show": always expanded
 */
export function resolveReasoningMode(
  part: ReasoningPart,
  storedMode: "show" | "hide" | null,
  pin: DisplayMode | null,
  cfg: DisplayConfig,
): DisplayMode {
  if (pin != null) return pin

  const isDone = part.time.end !== undefined

  if (storedMode === "hide") return "collapsed"
  if (storedMode === "show") return "expanded"

  // New user path (no kv)
  if (!isDone) return cfg.reasoning.streaming
  return cfg.reasoning.finished
}

export function buildReasoningViewModel(
  part: ReasoningPart,
  storedMode: "show" | "hide" | null,
  pin: DisplayMode | null,
  cfg: DisplayConfig,
): ReasoningViewModel {
  const mode = resolveReasoningMode(part, storedMode, pin, cfg)
  const isDone = part.time.end !== undefined
  const durationMs = isDone ? (part.time.end ?? 0) - part.time.start : null
  const summary = reasoningSummary(part.text.replace("[REDACTED]", "").trim())

  return {
    mode,
    title: summary.title,
    body: summary.body,
    durationMs,
    userPinned: pin != null,
    status: isDone ? "done" : "streaming",
  }
}
