import { beforeAll, expect, mock, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createEffect, createRoot } from "solid-js"

let createReviewPanelState: typeof import("@/pages/session/kit/review-panel-state").createReviewPanelState
let read: ((value: string | null) => void) | undefined

const storage: AsyncStorage = {
  getItem: () => new Promise((resolve) => (read = resolve)),
  setItem: async () => undefined,
  removeItem: async () => undefined,
  clear: async () => undefined,
  key: async () => null,
  getLength: async () => 0,
  length: Promise.resolve(0),
}

beforeAll(async () => {
  mock.module("@opencode-ai/session-ui/kit/session-review", () => ({
    SESSION_REVIEW_SIDEBAR_WIDTH_DEFAULT: 240,
    SESSION_REVIEW_SIDEBAR_WIDTH_MIN: 200,
    SESSION_REVIEW_SIDEBAR_WIDTH_MAX: 480,
  }))
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "desktop", storage: () => storage }),
  }))

  createReviewPanelState = (await import("@/pages/session/kit/review-panel-state")).createReviewPanelState
})

test("enables sidebar motion only after custom width hydration", async () => {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const state = createReviewPanelState()
      const transition =
        "sidebarTransition" in state && typeof state.sidebarTransition === "function"
          ? (state.sidebarTransition as () => boolean)
          : undefined

      try {
        expect(transition).toBeFunction()
        expect(transition?.()).toBeFalse()
        expect(state.sidebarWidth()).toBe(240)
      } catch (error) {
        dispose()
        reject(error)
        return
      }

      createEffect(() => {
        if (!transition?.()) return
        try {
          expect(state.sidebarWidth()).toBe(360)
          dispose()
          resolve()
        } catch (error) {
          dispose()
          reject(error)
        }
      })

      read?.(JSON.stringify({ sidebarOpened: true, sidebarWidth: 360, expandMode: "collapse" }))
    })
  })
})
