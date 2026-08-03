import type { ReasoningPart } from "@opencode-ai/sdk/v2"
import type { DisplayConfig } from "../config"
import type { DisplayMode } from "../mode"
import { toEpochMs } from "../header-utils"

export interface ReasoningViewModel {
  mode: DisplayMode
  title: string | null
  body: string
  durationMs: number | null
  userPinned: boolean
  status: "streaming" | "done"
  /** Same fold contract as tools — always clickable when body or streaming. */
  clickable: boolean
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

  const isDone = toEpochMs(part.time?.end) != null

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
  const startMs = toEpochMs(part.time?.start)
  const endMs = toEpochMs(part.time?.end)
  // Prefer explicit end; treat missing/invalid end as still streaming.
  const isDone = endMs != null
  const durationMs =
    isDone && startMs != null && endMs != null && endMs >= startMs ? endMs - startMs : null
  const summary = reasoningSummary(part.text.replace("[REDACTED]", "").trim())
  const body = summary.body

  return {
    mode,
    title: summary.title,
    body,
    durationMs,
    userPinned: pin != null,
    status: isDone ? "done" : "streaming",
    clickable: body.length > 0 || !isDone,
  }
}
