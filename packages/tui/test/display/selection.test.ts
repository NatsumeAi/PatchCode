import { afterEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createEntrySelection } from "../../src/display/selection"
import { applyToAll, allExpanded, clearPins, getPin } from "../../src/display/pin-store"

afterEach(() => clearPins())

describe("createEntrySelection", () => {
  test("empty list → no selection", () =>
    createRoot(() => {
      const s = createEntrySelection()
      s.setList([])
      expect(s.selectedId()).toBeNull()
    }))

  test("selectNext wraps", () =>
    createRoot(() => {
      const s = createEntrySelection()
      s.setList([
        { partId: "a", kind: "tool" },
        { partId: "b", kind: "tool" },
      ])
      s.selectNext()
      expect(s.selectedId()).toBe("a")
      s.selectNext()
      expect(s.selectedId()).toBe("b")
      s.selectNext()
      expect(s.selectedId()).toBe("a")
    }))

  test("selectPrev wraps", () =>
    createRoot(() => {
      const s = createEntrySelection()
      s.setList([
        { partId: "a", kind: "tool" },
        { partId: "b", kind: "tool" },
      ])
      s.selectPrev()
      expect(s.selectedId()).toBe("b")
    }))

  test("selectedIndex resets when list shrinks", () =>
    createRoot(() => {
      const s = createEntrySelection()
      s.setList([
        { partId: "a", kind: "tool" },
        { partId: "b", kind: "tool" },
        { partId: "c", kind: "tool" },
      ])
      s.selectNext()
      s.selectNext()
      expect(s.selectedId()).toBe("b")
      s.setList([{ partId: "a", kind: "tool" }])
      expect(s.selectedIndex()).toBe(0)
    }))

  test("selectById selects matching entry", () =>
    createRoot(() => {
      const s = createEntrySelection()
      s.setList([
        { partId: "a", kind: "tool" },
        { partId: "b", kind: "tool" },
        { partId: "c", kind: "tool" },
      ])
      s.selectById("b")
      expect(s.selectedId()).toBe("b")
      s.selectById("missing")
      expect(s.selectedId()).toBe("b")
    }))
})

describe("pin-store applyToAll / allExpanded", () => {
  test("applyToAll pins every id", () => {
    applyToAll(["a", "b", "c"], "expanded")
    expect(getPin("a")).toBe("expanded")
    expect(getPin("b")).toBe("expanded")
    expect(getPin("c")).toBe("expanded")
  })

  test("allExpanded true only when every id expanded", () => {
    applyToAll(["a", "b"], "expanded")
    expect(allExpanded(["a", "b"])).toBe(true)
    applyToAll(["b"], "collapsed")
    expect(allExpanded(["a", "b"])).toBe(false)
  })

  test("allExpanded false on empty list", () => {
    expect(allExpanded([])).toBe(false)
  })
})
