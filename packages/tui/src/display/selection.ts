import { createMemo, createSignal } from "solid-js"

export interface SelectableEntry {
  partId: string
  kind: "tool" | "reasoning"
}

export function createEntrySelection() {
  const [list, setList] = createSignal<SelectableEntry[]>([])
  const [index, setIndex] = createSignal(-1)

  const selectedId = createMemo(() => {
    const i = index()
    if (i < 0) return null
    return list()[i]?.partId ?? null
  })

  const clamp = (i: number) => {
    const len = list().length
    if (len === 0) return -1
    if (i < 0) return len - 1
    if (i >= len) return 0
    return i
  }

  return {
    setList(items: SelectableEntry[]) {
      setList(items)
      if (index() >= items.length) setIndex(items.length > 0 ? 0 : -1)
    },
    selectedIndex: index,
    selectedId,
    /** Select by partId; no-op when absent. */
    selectById(partId: string) {
      const idx = list().findIndex((e) => e.partId === partId)
      if (idx >= 0) setIndex(idx)
    },
    selectNext() {
      setIndex(clamp(index() + 1))
    },
    selectPrev() {
      setIndex(clamp(index() - 1))
    },
  }
}

export type EntrySelection = ReturnType<typeof createEntrySelection>
