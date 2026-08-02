export type SidebarMode = "hidden" | "dock" | "overlay"

export const DEFAULT_SIDEBAR_WIDTH = 34
export const MIN_SIDEBAR_WIDTH = 20
export const MAX_SIDEBAR_WIDTH = 64
// Two layout columns: one visible boundary plus one extra hit-target column so
// the first drag event after mouse-down still lands on the handle. The second
// column renders transparent (no second border).
export const RESIZE_HANDLE_WIDTH = 2
export const MIN_MAIN_CONTENT_WIDTH = 72
export const MAIN_HORIZONTAL_PADDING = 4
const OVERLAY_PADDING = 0

export type SidebarLayout = {
  mode: SidebarMode
  requestedWidth: number
  effectiveWidth: number
  mainContentWidth: number
  handleVisible: boolean
}

export function normalizeSidebarWidth(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(value)))
}

export function resolveSidebarLayout(input: {
  terminalWidth: number
  requestedWidth: unknown
  visible: boolean
}): SidebarLayout {
  const requestedWidth = normalizeSidebarWidth(input.requestedWidth)
  const mainContentWidth = Math.max(0, input.terminalWidth - MAIN_HORIZONTAL_PADDING)
  if (!input.visible) {
    return { mode: "hidden", requestedWidth, effectiveWidth: 0, mainContentWidth, handleVisible: false }
  }

  const canDock =
    input.terminalWidth >= MIN_MAIN_CONTENT_WIDTH + requestedWidth + RESIZE_HANDLE_WIDTH + MAIN_HORIZONTAL_PADDING
  if (canDock) {
    return {
      mode: "dock",
      requestedWidth,
      effectiveWidth: requestedWidth,
      mainContentWidth: Math.max(
        0,
        input.terminalWidth - requestedWidth - RESIZE_HANDLE_WIDTH - MAIN_HORIZONTAL_PADDING,
      ),
      handleVisible: true,
    }
  }

  // The handle and rail share the terminal edge; the rail can never be wider
  // than the space left after the handle, or the pair would overflow.
  const overlayCapacity = Math.max(0, input.terminalWidth - RESIZE_HANDLE_WIDTH - OVERLAY_PADDING)
  const overlayWidth = Math.min(MAX_SIDEBAR_WIDTH, overlayCapacity)
  return {
    mode: "overlay",
    requestedWidth,
    effectiveWidth: overlayWidth >= 1 ? Math.min(requestedWidth, overlayWidth) : 0,
    mainContentWidth,
    handleVisible: overlayWidth >= 1,
  }
}

// Returns the raw requested-width candidate; the state controller clamps it.
export function widthFromDrag(input: { startWidth: number; startX: number; currentX: number }) {
  return input.startWidth - (input.currentX - input.startX)
}

export function stepSidebarWidth(width: unknown, delta: -1 | 1) {
  const normalized = normalizeSidebarWidth(width)
  return normalizeSidebarWidth(normalized + 2 * delta)
}
