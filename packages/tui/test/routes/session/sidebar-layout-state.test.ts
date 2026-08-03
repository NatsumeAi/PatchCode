import { createRoot, createSignal } from "solid-js/dist/solid.js"
import { describe, expect, test } from "bun:test"
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "../../../src/util/sidebar-layout"
import { createSidebarLayoutState } from "../../../src/routes/session/sidebar-layout-state"

function setup(initial: { terminalWidth?: number; visible?: boolean; storedWidth?: unknown; ready?: boolean } = {}) {
  const persisted: number[] = []
  const [terminalWidth, setTerminalWidth] = createSignal(initial.terminalWidth ?? 120)
  const [visible, setVisible] = createSignal(initial.visible ?? true)
  const [storedWidth, setStoredWidth] = createSignal<unknown>(initial.storedWidth ?? 42)
  const [ready, setReady] = createSignal(initial.ready ?? true)
  const state = createSidebarLayoutState({
    terminalWidth,
    visible,
    storedWidth,
    ready,
    persist: (width) => persisted.push(width),
  })
  return { state, persisted, terminalWidth, setTerminalWidth, visible, setVisible, storedWidth, setStoredWidth, ready, setReady }
}

describe("createSidebarLayoutState", () => {
  test("initializes requested width from the stored value", () => {
    createRoot(() => {
      const { state } = setup({ storedWidth: 56 })
      expect(state.requestedWidth()).toBe(56)
      expect(state.draftWidth()).toBeUndefined()
      expect(state.resizing()).toBe(false)
    })
  })

  test("normalizes an invalid stored width to the default", () => {
    createRoot(() => {
      const { state } = setup({ storedWidth: Number.NaN })
      expect(state.requestedWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)
    })
  })

  test("drags update only the draft until end, then commit and persist exactly once", () => {
    createRoot(() => {
      const { state, persisted } = setup()
      expect(state.requestedWidth()).toBe(42)
      const mainBefore = state.layout().mainContentWidth
      state.beginResize(100)
      state.updateResize(90)
      expect(state.draftWidth()).toBe(52)
      expect(state.layout().effectiveWidth).toBe(52)
      // Main pane width is frozen during drag (avoids full transcript reflow).
      expect(state.layout().mainContentWidth).toBe(mainBefore)
      expect(persisted).toEqual([])
      state.endResize()
      expect(state.requestedWidth()).toBe(52)
      expect(state.draftWidth()).toBeUndefined()
      expect(state.resizing()).toBe(false)
      expect(persisted).toEqual([52])
      // After commit, main content width reflects the new rail size.
      expect(state.layout().mainContentWidth).not.toBe(mainBefore)
    })
  })

  test("identical drag columns do not thrash draft writes", () => {
    createRoot(() => {
      const { state } = setup()
      state.beginResize(100)
      state.updateResize(90)
      expect(state.draftWidth()).toBe(52)
      // Sub-column jitter still rounds to 52 — draft stays put.
      state.updateResize(90.4)
      expect(state.draftWidth()).toBe(52)
      state.endResize()
      expect(state.requestedWidth()).toBe(52)
    })
  })

  test("dragging right narrows the rail", () => {
    createRoot(() => {
      const { state, persisted } = setup()
      state.beginResize(100)
      state.updateResize(110)
      state.endResize()
      expect(state.requestedWidth()).toBe(32)
      expect(persisted).toEqual([32])
    })
  })

  test("drag candidates clamp to the legal range", () => {
    createRoot(() => {
      const { state, persisted } = setup()
      state.beginResize(100)
      state.updateResize(0)
      expect(state.draftWidth()).toBe(MAX_SIDEBAR_WIDTH)
      state.updateResize(500)
      expect(state.draftWidth()).toBe(MIN_SIDEBAR_WIDTH)
      state.endResize()
      expect(persisted).toEqual([MIN_SIDEBAR_WIDTH])
    })
  })

  test("cancelling a drag discards the draft and never persists", () => {
    createRoot(() => {
      const { state, persisted } = setup()
      state.beginResize(100)
      state.updateResize(80)
      expect(state.draftWidth()).toBe(62)
      state.cancelResize()
      expect(state.requestedWidth()).toBe(42)
      expect(state.draftWidth()).toBeUndefined()
      expect(state.resizing()).toBe(false)
      expect(persisted).toEqual([])
    })
  })

  test("beginResize is rejected while already resizing", () => {
    createRoot(() => {
      const { state, persisted } = setup()
      state.beginResize(100)
      state.updateResize(100)
      state.beginResize(200)
      state.updateResize(90)
      state.endResize()
      expect(state.requestedWidth()).toBe(52)
      expect(persisted).toEqual([52])
    })
  })

  test("a repeated begin before any drag resets the drag start", () => {
    createRoot(() => {
      const { state, persisted } = setup()
      state.beginResize(100)
      state.beginResize(200)
      state.updateResize(190)
      state.endResize()
      expect(state.requestedWidth()).toBe(52)
      expect(persisted).toEqual([52])
    })
  })

  test("a drag sequence with no drag events leaves no stuck state", () => {
    createRoot(() => {
      const { state, persisted } = setup()
      state.beginResize(100)
      expect(state.resizing()).toBe(false)
      state.cancelResize()
      expect(state.resizing()).toBe(false)
      expect(state.draftWidth()).toBeUndefined()
      expect(state.requestedWidth()).toBe(42)
      expect(persisted).toEqual([])
      state.beginResize(150)
      state.updateResize(140)
      expect(state.resizing()).toBe(true)
      state.endResize()
      expect(state.requestedWidth()).toBe(52)
      expect(persisted).toEqual([52])
    })
  })

  test("endResize is idempotent after the first completion", () => {
    createRoot(() => {
      const { state, persisted } = setup()
      state.beginResize(100)
      state.updateResize(90)
      state.endResize()
      state.endResize()
      expect(state.requestedWidth()).toBe(52)
      expect(persisted).toEqual([52])
    })
  })

  test("a terminal shrink changes mode and effective width but not the requested width", () => {
    createRoot(() => {
      const { state, setTerminalWidth } = setup({ terminalWidth: 160 })
      expect(state.layout().mode).toBe("dock")
      expect(state.layout().effectiveWidth).toBe(42)
      setTerminalWidth(80)
      expect(state.requestedWidth()).toBe(42)
      expect(state.layout().mode).toBe("overlay")
      expect(state.layout().effectiveWidth).toBe(42)
      expect(state.layout().mainContentWidth).toBe(76)
    })
  })

  test("terminal growth restores the requested width", () => {
    createRoot(() => {
      const { state, setTerminalWidth } = setup({ terminalWidth: 80 })
      expect(state.layout().mode).toBe("overlay")
      setTerminalWidth(160)
      expect(state.layout().mode).toBe("dock")
      expect(state.layout().effectiveWidth).toBe(42)
      expect(state.requestedWidth()).toBe(42)
    })
  })

  test("a terminal resize during a drag keeps the draft and reclamps", () => {
    createRoot(() => {
      const { state, setTerminalWidth, persisted } = setup({ terminalWidth: 160 })
      state.beginResize(100)
      state.updateResize(90)
      expect(state.draftWidth()).toBe(52)
      setTerminalWidth(80)
      expect(state.draftWidth()).toBe(52)
      expect(state.layout().mode).toBe("overlay")
      expect(state.layout().effectiveWidth).toBe(52)
      state.endResize()
      expect(state.requestedWidth()).toBe(52)
      expect(persisted).toEqual([52])
    })
  })

  test("keyboard commands persist exactly once and share the drag clamp", () => {
    createRoot(() => {
      const { state, persisted } = setup()
      state.increaseWidth()
      expect(state.requestedWidth()).toBe(44)
      expect(persisted).toEqual([44])
      state.decreaseWidth()
      expect(state.requestedWidth()).toBe(42)
      expect(persisted).toEqual([44, 42])
      state.resetWidth()
      expect(state.requestedWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)
      expect(persisted).toEqual([44, 42, DEFAULT_SIDEBAR_WIDTH])
    })
  })

  test("repeated keyboard commands clamp at the bounds", () => {
    createRoot(() => {
      const { state, persisted } = setup({ storedWidth: 28 })
      for (let i = 0; i < 10; i++) state.decreaseWidth()
      expect(state.requestedWidth()).toBe(MIN_SIDEBAR_WIDTH)
      expect(persisted.at(-1)).toBe(MIN_SIDEBAR_WIDTH)
      for (let i = 0; i < 40; i++) state.increaseWidth()
      expect(state.requestedWidth()).toBe(MAX_SIDEBAR_WIDTH)
      expect(persisted.at(-1)).toBe(MAX_SIDEBAR_WIDTH)
    })
  })

  test("hydration never overwrites a local mutation", () => {
    createRoot(() => {
      const { state, setStoredWidth, setReady, persisted } = setup({ ready: false })
      state.increaseWidth()
      expect(state.requestedWidth()).toBe(44)
      setStoredWidth(28)
      setReady(true)
      expect(state.requestedWidth()).toBe(44)
      expect(persisted).toEqual([44])
    })
  })

  test("hydration applies when no local mutation happened", () => {
    let state!: ReturnType<typeof setup>["state"]
    let setStoredWidth!: ReturnType<typeof setup>["setStoredWidth"]
    let setReady!: ReturnType<typeof setup>["setReady"]
    createRoot(() => {
      ;({ state, setStoredWidth, setReady } = setup({ ready: false }))
      expect(state.requestedWidth()).toBe(42)
      setStoredWidth(60)
      setReady(true)
    })
    // The createRoot update queue has flushed by now, so the hydration effect ran.
    expect(state.requestedWidth()).toBe(60)
  })

  test("hidden layout still accepts keyboard width changes", () => {
    createRoot(() => {
      const { state, setVisible, persisted } = setup()
      setVisible(false)
      expect(state.layout().mode).toBe("hidden")
      state.increaseWidth()
      expect(state.requestedWidth()).toBe(44)
      expect(persisted).toEqual([44])
    })
  })

  test("beginResize is rejected when the handle is not visible", () => {
    createRoot(() => {
      const { state, setVisible } = setup()
      setVisible(false)
      state.beginResize(100)
      expect(state.resizing()).toBe(false)
      expect(state.draftWidth()).toBeUndefined()
    })
  })
})
