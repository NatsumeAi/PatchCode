import { createSignal } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { DisplayMode } from "@opencode-ai/session-display"

/**
 * Session-memory pin store per §3.8.
 * Key = part.id, value = pinned DisplayMode.
 * Lifetime: session memory (lost on refresh — explicit product behavior).
 *
 * Solid store is path-fine-grained: reading pins[id] only re-runs when that
 * id changes. A group epoch is kept only for verb-group reclassification.
 */
const [pins, setPins] = createStore<Record<string, DisplayMode>>({})
const [groupEpoch, setGroupEpoch] = createSignal(0)

function bumpGroup() {
  setGroupEpoch((v) => v + 1)
}

/** Subscribe in verb-group / classify memos that depend on any pin. */
export function pinGroupVersion(): number {
  return groupEpoch()
}

/** Reactive: track only this part's pin when called from a Solid tracking scope. */
export function getPin(partId: string): DisplayMode | null {
  return pins[partId] ?? null
}

/** §3.8: click toggles collapsed↔expanded; truncated→expanded; expanded→collapsed */
export function togglePin(partId: string, current: DisplayMode): DisplayMode {
  const next: DisplayMode = current === "expanded" ? "collapsed" : "expanded"
  setPins(partId, next)
  bumpGroup()
  return next
}

/** Direct pin write for keyboard folding (h/l/e act on the selected entry). */
export function setPin(partId: string, mode: DisplayMode): void {
  if (pins[partId] === mode) return
  setPins(partId, mode)
  bumpGroup()
}

/** Pin every entry id to one mode (E: expand-all / collapse-all). */
export function applyToAll(ids: readonly string[], mode: DisplayMode): void {
  let changed = false
  setPins(
    produce((draft) => {
      for (const id of ids) {
        if (draft[id] === mode) continue
        draft[id] = mode
        changed = true
      }
    }),
  )
  if (changed) bumpGroup()
}

/** True when every id is pinned expanded (drives E direction). */
export function allExpanded(ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => pins[id] === "expanded")
}

export function clearPins(): void {
  if (Object.keys(pins).length === 0) return
  setPins(reconcile({}))
  bumpGroup()
}

/** Drop a single pin (e.g. auto-collapse when reasoning completes). */
export function clearPin(partId: string): void {
  if (pins[partId] == null) return
  setPins(
    produce((draft) => {
      delete draft[partId]
    }),
  )
  bumpGroup()
}
