import {
  SESSION_REVIEW_SIDEBAR_WIDTH_DEFAULT,
  SESSION_REVIEW_SIDEBAR_WIDTH_MAX,
  SESSION_REVIEW_SIDEBAR_WIDTH_MIN,
  type SessionReviewExpandMode,
} from "@opencode-ai/session-ui/kit/session-review"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

export function createReviewPanelState() {
  const [store, setStore, , ready] = persisted(
    Persist.global("review-panel", ["review-panel-v2"]),
    createStore({
      sidebarOpened: true,
      sidebarWidth: SESSION_REVIEW_SIDEBAR_WIDTH_DEFAULT,
      expandMode: "collapse" as SessionReviewExpandMode,
    }),
  )
  // The filter is transient by design: a persisted filter would silently hide
  // files after a reload.
  const [filter, setFilter] = createSignal("")

  return {
    sidebarOpened: () => store.sidebarOpened,
    sidebarWidth: () => store.sidebarWidth,
    sidebarTransition: ready,
    filter,
    setFilter,
    expandMode: () => store.expandMode,
    setExpandMode: (mode: SessionReviewExpandMode) => setStore("expandMode", mode),
    resizeSidebar: (width: number) =>
      setStore(
        "sidebarWidth",
        Math.min(SESSION_REVIEW_SIDEBAR_WIDTH_MAX, Math.max(SESSION_REVIEW_SIDEBAR_WIDTH_MIN, width)),
      ),
    toggleSidebar: () => setStore("sidebarOpened", (opened) => !opened),
  }
}

export type ReviewPanelState = ReturnType<typeof createReviewPanelState>
