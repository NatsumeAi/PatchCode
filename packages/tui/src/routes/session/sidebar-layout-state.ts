import { createEffect, createMemo, createSignal } from "solid-js/dist/solid.js"
import type { Accessor } from "solid-js"
import {
  DEFAULT_SIDEBAR_WIDTH,
  normalizeSidebarWidth,
  resolveSidebarLayout,
  stepSidebarWidth,
  widthFromDrag,
  type SidebarLayout,
} from "../../util/sidebar-layout"

export type SidebarLayoutStateOptions = {
  terminalWidth: Accessor<number>
  visible: Accessor<boolean>
  storedWidth: Accessor<unknown>
  ready: Accessor<boolean>
  persist: (width: number) => void
}

export type SidebarLayoutState = {
  requestedWidth: Accessor<number>
  draftWidth: Accessor<number | undefined>
  resizing: Accessor<boolean>
  layout: Accessor<SidebarLayout>
  beginResize(startX: number): void
  updateResize(currentX: number): void
  endResize(): void
  cancelResize(): void
  increaseWidth(): void
  decreaseWidth(): void
  resetWidth(): void
}

export function createSidebarLayoutState(options: SidebarLayoutStateOptions): SidebarLayoutState {
  const [requestedWidth, setRequestedWidth] = createSignal(normalizeSidebarWidth(options.storedWidth()))
  const [draftWidth, setDraftWidth] = createSignal<number>()
  const [resizing, setResizing] = createSignal(false)
  const [startX, setStartX] = createSignal<number>()
  const [startWidth, setStartWidth] = createSignal<number>()
  let locallyMutated = false

  createEffect(() => {
    if (locallyMutated || !options.ready()) return
    setRequestedWidth(normalizeSidebarWidth(options.storedWidth()))
  })

  const layout = createMemo(() =>
    resolveSidebarLayout({
      terminalWidth: options.terminalWidth(),
      requestedWidth: draftWidth() ?? requestedWidth(),
      visible: options.visible(),
    }),
  )

  function beginResize(startXValue: number) {
    if (resizing() || !layout().handleVisible) return
    if (startX() !== undefined) clearDrag()
    setStartX(startXValue)
    setStartWidth(requestedWidth())
    setDraftWidth(requestedWidth())
  }

  function updateResize(currentX: number) {
    const start = startX()
    const width = startWidth()
    if (start === undefined || width === undefined) return
    if (!resizing()) setResizing(true)
    setDraftWidth(normalizeSidebarWidth(widthFromDrag({ startWidth: width, startX: start, currentX })))
  }

  function endResize() {
    if (!resizing()) return
    commitWidth(draftWidth() ?? requestedWidth())
    clearDrag()
  }

  function cancelResize() {
    clearDrag()
  }

  function clearDrag() {
    setResizing(false)
    setDraftWidth(undefined)
    setStartX(undefined)
    setStartWidth(undefined)
  }

  function commitWidth(width: unknown) {
    const next = normalizeSidebarWidth(width)
    locallyMutated = true
    setRequestedWidth(next)
    setDraftWidth(undefined)
    options.persist(next)
  }

  function increaseWidth() {
    commitWidth(stepSidebarWidth(requestedWidth(), 1))
  }

  function decreaseWidth() {
    commitWidth(stepSidebarWidth(requestedWidth(), -1))
  }

  function resetWidth() {
    commitWidth(DEFAULT_SIDEBAR_WIDTH)
  }

  return {
    requestedWidth,
    draftWidth,
    resizing,
    layout,
    beginResize,
    updateResize,
    endResize,
    cancelResize,
    increaseWidth,
    decreaseWidth,
    resetWidth,
  }
}
