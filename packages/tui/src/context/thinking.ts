import { createMemo, type Setter } from "solid-js"
import { useKV } from "./kv"

/**
 * Explicit user override for thinking display.
 * - null / unset = **auto**: expand while streaming, collapse when done (product default)
 * - "show" = always expanded
 * - "hide" = always collapsed
 *
 * DO NOT default new users to "hide". That permanently disables the auto
 * expand→collapse lifecycle. See nextThinkingPreference / storedMode.
 */
export type ThinkingMode = "show" | "hide"

/** Preference including auto (no explicit kv override). */
export type ThinkingPreference = "auto" | ThinkingMode

const MODES: readonly ThinkingMode[] = ["show", "hide"] as const

/** One-time migration: clear hide seeded by buggy kv.signal(..., "hide"). */
const AUTO_LIFECYCLE_MIGRATION = "thinking_auto_lifecycle_v1"

// OpenAI's Responses API surfaces reasoning summaries that start with a bolded
// title block: "**Inspecting PR workflow**\n\n<body>". Treat that first block,
// or a complete title still awaiting its body while streaming, as disclosure
// metadata so the TUI can style its header independently from the markdown body.
export function reasoningSummary(text: string) {
  const content = text.trim()
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  if (!match) return { title: null, body: content }
  return { title: match[1].trim(), body: content.slice(match[0].length).trimEnd() }
}

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
}

/**
 * @deprecated Prefer nextThinkingPreference(storedMode). Cycling show↔hide
 * from a fake "show" when kv is unset writes "hide" and kills auto lifecycle.
 */
export function nextThinkingMode(current: ThinkingMode): ThinkingMode {
  const idx = MODES.indexOf(current)
  return MODES[(idx + 1) % MODES.length] ?? "show"
}

/**
 * Cycle explicit preference: auto → show → hide → auto.
 * Pass null when kv has no override (auto).
 */
export function nextThinkingPreference(current: ThinkingMode | null): ThinkingMode | null {
  if (current === null) return "show"
  if (current === "show") return "hide"
  return null
}

/** Slash/command label for the upcoming preference after one toggle. */
export function thinkingPreferenceActionTitle(current: ThinkingMode | null): string {
  const next = nextThinkingPreference(current)
  if (next === "show") return "Always expand thinking"
  if (next === "hide") return "Always collapse thinking"
  return "Auto-fold thinking"
}

export function useThinkingMode() {
  const kv = useKV()
  // Capture pre-state before `kv.signal` seeds a default, so we can detect
  // first-time users with a legacy `thinking_visibility` boolean and migrate.
  // The KVProvider only renders children once kv.ready, so reads here are safe.
  const hadStored = kv.get("thinking_mode") !== undefined
  const legacy = kv.get("thinking_visibility")
  // §9/D5: Do NOT seed "hide"/"show" for new users. undefined = auto lifecycle.
  const [stored, setStored] = kv.signal<ThinkingMode | undefined>("thinking_mode", undefined)

  const write = (value: ThinkingMode | undefined) => {
    setStored((() => value) as unknown as Setter<ThinkingMode | undefined>)
  }

  const set = (next: ThinkingMode | ((prev: ThinkingMode) => ThinkingMode)) => {
    if (typeof next === "function") {
      const prev = isThinkingMode(stored()) ? stored()! : "show"
      write(next(prev))
      return
    }
    write(next)
  }

  /** Set override, or null to clear kv and restore auto expand→collapse. */
  const setPreference = (next: ThinkingMode | null) => {
    write(next ?? undefined)
  }

  // One-time: previous buggy default wrote thinking_mode="hide" for everyone via
  // kv.signal(..., "hide"). Clear it unless the user had explicit legacy hide.
  if (!kv.get(AUTO_LIFECYCLE_MIGRATION)) {
    kv.set(AUTO_LIFECYCLE_MIGRATION, true)
    if (stored() === "hide" && legacy !== false) {
      write(undefined)
    }
  }

  // Preserve previous experience for users who had explicitly toggled the
  // legacy `thinking_visibility` boolean.
  if (!hadStored) {
    if (legacy === true) write("show")
    else if (legacy === false) write("hide")
  }

  if ((stored() as string) === "minimal") write("hide")

  // Backward-compatible mode accessor. When unset, report "show" only for
  // legacy UI — kernel must use storedMode (null=auto).
  const mode = createMemo<ThinkingMode>(() => {
    const value = stored()
    return isThinkingMode(value) ? value : "show"
  })

  // null = auto → kernel expand(streaming)→collapse(done).
  const storedMode = createMemo<ThinkingMode | null>(() => {
    const value = stored()
    if (isThinkingMode(value)) return value
    return null
  })

  const preference = createMemo<ThinkingPreference>(() => storedMode() ?? "auto")

  return {
    mode,
    storedMode,
    preference,
    set,
    setPreference,
  }
}
