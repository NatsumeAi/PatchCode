import { createSignal } from "solid-js"
import type { DisplayMode } from "@opencode-ai/session-display"

/**
 * Session-memory pin store per §3.8.
 * Key = part.id, value = pinned DisplayMode.
 * Lifetime: session memory (lost on refresh — explicit product behavior).
 */
const pins = new Map<string, DisplayMode>()
const [version, bump] = createSignal(0)

/** Reactive dependency: subscribe inside memos that read getPin. */
export function pinVersion(): number {
  return version()
}

export function getPin(partId: string): DisplayMode | null {
  return pins.get(partId) ?? null
}

/** §3.8: click toggles collapsed↔expanded; truncated→expanded; expanded→collapsed */
export function togglePin(partId: string, current: DisplayMode): DisplayMode {
  const next: DisplayMode = current === "expanded" ? "collapsed" : "expanded"
  pins.set(partId, next)
  bump((v) => v + 1)
  return next
}

/** Direct pin write for keyboard folding (h/l/e act on the selected entry). */
export function setPin(partId: string, mode: DisplayMode): void {
  pins.set(partId, mode)
  bump((v) => v + 1)
}

/** Pin every entry id to one mode (E: expand-all / collapse-all). */
export function applyToAll(ids: readonly string[], mode: DisplayMode): void {
  for (const id of ids) {
    pins.set(id, mode)
  }
  bump((v) => v + 1)
}

/** True when every id is pinned expanded (drives E direction). */
export function allExpanded(ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => pins.get(id) === "expanded")
}

export function clearPins(): void {
  pins.clear()
  bump((v) => v + 1)
}
