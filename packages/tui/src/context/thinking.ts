import { createMemo, type Setter } from "solid-js"
import { useKV } from "./kv"

export type ThinkingMode = "show" | "hide"

const MODES: readonly ThinkingMode[] = ["show", "hide"] as const

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

// Cycle order matches the slash command: show → hide → show.
export function nextThinkingMode(current: ThinkingMode): ThinkingMode {
  const idx = MODES.indexOf(current)
  return MODES[(idx + 1) % MODES.length] ?? "show"
}

export function useThinkingMode() {
  const kv = useKV()
  // Capture pre-state before `kv.signal` seeds a default, so we can detect
  // first-time users with a legacy `thinking_visibility` boolean and migrate.
  // The KVProvider only renders children once kv.ready, so reads here are safe.
  const hadStored = kv.get("thinking_mode") !== undefined
  const legacy = kv.get("thinking_visibility")
  // §9/D5: Do NOT seed a default for new users. undefined = "kernel decides".
  // Existing users who already have a kv value keep it untouched.
  const [stored, setStored] = kv.signal<ThinkingMode | undefined>("thinking_mode", undefined)

  // The kv signal exposes its setter typed as `Setter<T>` which carries Solid's
  // overload set; passing an updater fn through a property access loses the
  // bivariance trick the existing `setX((prev) => ...)` callsites rely on.
  // Wrap it in a sane shape so consumers can just call `set(next)` or pass
  // an updater.
  const set = (next: ThinkingMode | ((prev: ThinkingMode) => ThinkingMode)) => {
    if (typeof next === "function") setStored(next as Setter<ThinkingMode | undefined>)
    else setStored((() => next) as unknown as Setter<ThinkingMode | undefined>)
  }

  // Preserve previous experience for users who had explicitly toggled the
  // legacy `thinking_visibility` boolean. First-time users (no legacy key)
  // get undefined → kernel decides (streaming expanded → finished collapsed).
  // NOTE: do NOT migrate legacy false → hide for new installs that only have
  // the old key from defaults; only migrate when the user had an explicit bool.
  if (!hadStored) {
    if (legacy === true) set("show")
    else if (legacy === false) set("hide")
  }

  if ((stored() as string) === "minimal") set("hide")

  // Backward-compatible mode accessor for existing UI that reads thinkingMode().
  // When undefined, report "show" so commands/labels match the product default
  // (thinking is visible while streaming). Kernel still uses storedMode=null.
  const mode = createMemo<ThinkingMode>(() => {
    const value = stored()
    return isThinkingMode(value) ? value : "show"
  })

  // §3.7/§9: Expose stored mode for the display kernel.
  // null = new user (no explicit kv) → kernel applies expanded(streaming)→collapsed(done).
  // "hide"/"show" = user has explicit preference → kernel respects it.
  const storedMode = createMemo<ThinkingMode | null>(() => {
    const value = stored()
    if (isThinkingMode(value)) return value
    return null
  })

  return {
    mode,
    storedMode,
    set,
  }
}
