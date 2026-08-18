import type { ReasoningPart } from "@opencode-ai/sdk/api"
import type { DisplayConfig } from "../config"
import type { DisplayMode } from "../mode"
import { toEpochMs, toText } from "../header-utils"

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
 * Resolve reasoning display mode per product UX (locked):
 * - Auto (storedMode null): streaming → expanded; done → collapsed
 * - kv "hide": always collapsed
 * - kv "show": always expanded
 * - pin always wins when set
 *
 * DO NOT change the auto default to collapsed-while-streaming. Live thinking
 * must stay readable; finished thoughts fold.
 *
 * SSE may flush start+delta+end in one Solid batch. Adapters must call
 * `applyReasoningHoldOpen` so users still see content briefly after end.
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

  // Default lifecycle: expand while thinking → collapse when finished.
  // Always expanded while streaming (ignore cfg.streaming=collapsed).
  if (!isDone) return "expanded"
  return cfg.reasoning.finished
}

/** Brief post-end expand window so batched SSE still shows thinking once. */
export const REASONING_HOLD_OPEN_MS = 1500

/**
 * True when auto-lifecycle should keep a just-finished thought expanded
 * for a short window (batched end, or natural transition to done).
 */
export function shouldHoldReasoningOpen(input: {
  status: "streaming" | "done"
  mode: DisplayMode
  userPinned: boolean
  storedMode: "show" | "hide" | null
  endedAtMs: number | null
  nowMs: number
  holdOpenMs?: number
}): boolean {
  if (input.userPinned) return false
  if (input.storedMode != null) return false
  if (input.status !== "done") return false
  if (input.mode !== "collapsed") return false
  if (input.endedAtMs == null) return false
  const hold = input.holdOpenMs ?? REASONING_HOLD_OPEN_MS
  return input.nowMs - input.endedAtMs < hold
}

/** Apply hold-open overlay to a view model (adapter convenience). */
export function applyReasoningHoldOpen(
  vm: ReasoningViewModel,
  input: {
    storedMode: "show" | "hide" | null
    endedAtMs: number | null
    nowMs: number
    holdOpenMs?: number
  },
): ReasoningViewModel {
  if (
    !shouldHoldReasoningOpen({
      status: vm.status,
      mode: vm.mode,
      userPinned: vm.userPinned,
      storedMode: input.storedMode,
      endedAtMs: input.endedAtMs,
      nowMs: input.nowMs,
      holdOpenMs: input.holdOpenMs,
    })
  ) {
    return vm
  }
  return { ...vm, mode: "expanded" }
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
  const summary = reasoningSummary(toText(part.text).replace("[REDACTED]", "").trim())
  const body = summary.body

  return {
    mode,
    title: summary.title === null ? null : toText(summary.title),
    body,
    durationMs,
    userPinned: pin != null,
    status: isDone ? "done" : "streaming",
    clickable: body.length > 0 || summary.title != null || !isDone,
  }
}
