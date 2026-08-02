import { describe, expect, test } from "bun:test"
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAIN_HORIZONTAL_PADDING,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  RESIZE_HANDLE_WIDTH,
  normalizeSidebarWidth,
  resolveSidebarLayout,
  stepSidebarWidth,
  widthFromDrag,
} from "../../src/util/sidebar-layout"

describe("normalizeSidebarWidth", () => {
  test("defaults for missing or non-finite input", () => {
    expect(normalizeSidebarWidth(undefined)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(normalizeSidebarWidth(null)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(normalizeSidebarWidth("42")).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(normalizeSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(normalizeSidebarWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(normalizeSidebarWidth(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(normalizeSidebarWidth(-5)).toBe(MIN_SIDEBAR_WIDTH)
  })

  test("clamps to the legal dock range", () => {
    expect(normalizeSidebarWidth(0)).toBe(MIN_SIDEBAR_WIDTH)
    expect(normalizeSidebarWidth(12)).toBe(MIN_SIDEBAR_WIDTH)
    expect(normalizeSidebarWidth(20)).toBe(MIN_SIDEBAR_WIDTH)
    expect(normalizeSidebarWidth(34)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(normalizeSidebarWidth(64)).toBe(MAX_SIDEBAR_WIDTH)
    expect(normalizeSidebarWidth(90)).toBe(MAX_SIDEBAR_WIDTH)
    expect(normalizeSidebarWidth(1000)).toBe(MAX_SIDEBAR_WIDTH)
  })

  test("rounds fractional values", () => {
    expect(normalizeSidebarWidth(42.4)).toBe(42)
    expect(normalizeSidebarWidth(42.6)).toBe(43)
  })
})

describe("resolveSidebarLayout", () => {
  test("hidden mode keeps main content and hides the handle", () => {
    expect(resolveSidebarLayout({ terminalWidth: 200, requestedWidth: 42, visible: false })).toEqual({
      mode: "hidden",
      requestedWidth: 42,
      effectiveWidth: 0,
      mainContentWidth: 196,
      handleVisible: false,
    })
  })

  test("docks at the exact threshold 120", () => {
    expect(resolveSidebarLayout({ terminalWidth: 120, requestedWidth: 42, visible: true })).toEqual({
      mode: "dock",
      requestedWidth: 42,
      effectiveWidth: 42,
      mainContentWidth: 72,
      handleVisible: true,
    })
  })

  test("docks on wide terminals and subtracts rail, handle, and padding", () => {
    expect(resolveSidebarLayout({ terminalWidth: 160, requestedWidth: 42, visible: true })).toEqual({
      mode: "dock",
      requestedWidth: 42,
      effectiveWidth: 42,
      mainContentWidth: 112,
      handleVisible: true,
    })
  })

  test("overlays below the threshold without shrinking main content", () => {
    const layout = resolveSidebarLayout({ terminalWidth: 118, requestedWidth: 42, visible: true })
    expect(layout.mode).toBe("overlay")
    expect(layout.mainContentWidth).toBe(114)
    expect(layout.effectiveWidth).toBe(42)
    expect(layout.handleVisible).toBe(true)
  })

  test("overlay clamps to the largest width that fits in a narrow terminal", () => {
    const layout = resolveSidebarLayout({ terminalWidth: 60, requestedWidth: 64, visible: true })
    expect(layout.mode).toBe("overlay")
    expect(layout.effectiveWidth).toBe(58)
    expect(layout.handleVisible).toBe(true)
  })

  test("does not render a handle or rail when not even one column fits", () => {
    const layout = resolveSidebarLayout({ terminalWidth: 1, requestedWidth: 42, visible: true })
    expect(layout.mode).toBe("overlay")
    expect(layout.effectiveWidth).toBe(0)
    expect(layout.handleVisible).toBe(false)
    expect(layout.mainContentWidth).toBe(0)
  })

  test("a temporary narrow terminal never mutates requestedWidth", () => {
    const wide = resolveSidebarLayout({ terminalWidth: 160, requestedWidth: 42, visible: true })
    expect(wide.requestedWidth).toBe(42)
    const narrow = resolveSidebarLayout({ terminalWidth: 80, requestedWidth: 42, visible: true })
    expect(narrow.requestedWidth).toBe(42)
    expect(narrow.mode).toBe("overlay")
    expect(narrow.effectiveWidth).toBe(42)
  })

  test("dock main content width never goes negative", () => {
    // 72 + 64 + 2 + 4 = 142 is the exact dock threshold for the max width.
    const exact = resolveSidebarLayout({ terminalWidth: 142, requestedWidth: 64, visible: true })
    expect(exact.mode).toBe("dock")
    expect(exact.mainContentWidth).toBe(72)
    const tiny = resolveSidebarLayout({ terminalWidth: 20, requestedWidth: 42, visible: true })
    expect(tiny.mode).toBe("overlay")
    expect(tiny.mainContentWidth).toBe(16)
    expect(tiny.effectiveWidth).toBe(18)
  })

  test("hidden main content width clamps at zero", () => {
    expect(resolveSidebarLayout({ terminalWidth: 0, requestedWidth: 42, visible: false }).mainContentWidth).toBe(0)
  })

  test("main content width accounts for padding exactly once", () => {
    const dock = resolveSidebarLayout({ terminalWidth: 160, requestedWidth: 42, visible: true })
    expect(dock.mainContentWidth).toBe(160 - 42 - RESIZE_HANDLE_WIDTH - MAIN_HORIZONTAL_PADDING)
  })
})

describe("widthFromDrag", () => {
  test("dragging left increases the width", () => {
    expect(widthFromDrag({ startWidth: 42, startX: 100, currentX: 90 })).toBe(52)
  })

  test("dragging right decreases the width", () => {
    expect(widthFromDrag({ startWidth: 42, startX: 100, currentX: 110 })).toBe(32)
  })

  test("no movement keeps the width", () => {
    expect(widthFromDrag({ startWidth: 42, startX: 100, currentX: 100 })).toBe(42)
  })

  test("returns the raw candidate; clamping happens in the controller", () => {
    expect(widthFromDrag({ startWidth: 42, startX: 100, currentX: 0 })).toBe(142)
    expect(widthFromDrag({ startWidth: 42, startX: 100, currentX: 200 })).toBe(-58)
  })
})

describe("stepSidebarWidth", () => {
  test("two-column keyboard steps", () => {
    expect(stepSidebarWidth(42, 1)).toBe(44)
    expect(stepSidebarWidth(42, -1)).toBe(40)
  })

  test("clamps at both bounds", () => {
    expect(stepSidebarWidth(MIN_SIDEBAR_WIDTH, -1)).toBe(MIN_SIDEBAR_WIDTH)
    expect(stepSidebarWidth(64, 1)).toBe(64)
  })

  test("falls back to the default then steps", () => {
    expect(stepSidebarWidth(Number.NaN, 1)).toBe(DEFAULT_SIDEBAR_WIDTH + 2)
    expect(stepSidebarWidth("42", 1)).toBe(DEFAULT_SIDEBAR_WIDTH + 2)
  })
})
