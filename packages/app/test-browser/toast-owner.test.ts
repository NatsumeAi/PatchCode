import { describe, expect, test } from "bun:test"
import { createSignal, type JSX } from "solid-js"
import { showToast, toaster } from "@opencode-ai/ui/kit/toast"

describe("showToast", () => {
  test("creates no reactive computations at call time", () => {
    const [tick, setTick] = createSignal(0)
    let reads = 0
    const icon = (() => {
      reads++
      tick()
      return undefined
    }) as unknown as JSX.Element

    const id = showToast({ description: "test", icon })

    // Resolving the icon at call time creates an ownerless computation that is
    // never disposed and tracks its dependencies forever; it must only resolve
    // once the toast component renders.
    expect(reads).toBe(0)
    setTick(1)
    expect(reads).toBe(0)

    toaster.dismiss(id)
  })
})
