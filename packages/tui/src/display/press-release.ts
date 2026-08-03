/**
 * Activate only when press AND release both land on the same target,
 * without a drag (text selection / swipe). Prevents misfires from:
 * - mouseup after mousedown elsewhere (selection end)
 * - mousedown here then release outside
 * - drag-selecting body text
 */

export type PressReleaseHandlers = {
  onMouseDown: (event: { x?: number; y?: number }) => void
  onMouseUp: (event: { x?: number; y?: number }) => void
  onMouseOut?: () => void
}

/** Max cell movement between down and up still counted as a click. */
const DEFAULT_MAX_DRAG = 1

export function createPressReleaseClick(
  onActivate: () => void,
  options?: { maxDrag?: number },
): PressReleaseHandlers {
  const maxDrag = options?.maxDrag ?? DEFAULT_MAX_DRAG
  let armed = false
  let startX = 0
  let startY = 0

  return {
    onMouseDown(event) {
      armed = true
      startX = event.x ?? 0
      startY = event.y ?? 0
    },
    onMouseUp(event) {
      if (!armed) return
      armed = false
      const dx = Math.abs((event.x ?? 0) - startX)
      const dy = Math.abs((event.y ?? 0) - startY)
      if (dx > maxDrag || dy > maxDrag) return
      onActivate()
    },
    onMouseOut() {
      // Left the block before release → not a same-target click.
      armed = false
    },
  }
}
