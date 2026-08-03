import { describe, expect, test } from "bun:test"
import { createPressReleaseClick } from "../../src/display/press-release"

describe("createPressReleaseClick", () => {
  test("fires only when down and up both on target without drag", () => {
    let n = 0
    const h = createPressReleaseClick(() => {
      n += 1
    })
    h.onMouseDown({ x: 10, y: 5 })
    h.onMouseUp({ x: 10, y: 5 })
    expect(n).toBe(1)
  })

  test("mouseup alone does not fire", () => {
    let n = 0
    const h = createPressReleaseClick(() => {
      n += 1
    })
    h.onMouseUp({ x: 10, y: 5 })
    expect(n).toBe(0)
  })

  test("mousedown then mouseout then mouseup does not fire", () => {
    let n = 0
    const h = createPressReleaseClick(() => {
      n += 1
    })
    h.onMouseDown({ x: 10, y: 5 })
    h.onMouseOut?.()
    h.onMouseUp({ x: 10, y: 5 })
    expect(n).toBe(0)
  })

  test("drag beyond threshold does not fire", () => {
    let n = 0
    const h = createPressReleaseClick(() => {
      n += 1
    })
    h.onMouseDown({ x: 10, y: 5 })
    h.onMouseUp({ x: 10, y: 8 })
    expect(n).toBe(0)
  })

  test("small movement within threshold still fires", () => {
    let n = 0
    const h = createPressReleaseClick(() => {
      n += 1
    })
    h.onMouseDown({ x: 10, y: 5 })
    h.onMouseUp({ x: 11, y: 5 })
    expect(n).toBe(1)
  })
})
