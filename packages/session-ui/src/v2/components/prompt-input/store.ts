import { batch, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import type {
  PromptInputAgentPart,
  PromptInputAttachment,
  PromptInputComment,
  PromptInputFilePart,
  PromptInputModel,
  PromptInputPersistedState,
  PromptInputPrompt,
} from "./types"

export type PromptInputStoreTuple = [
  Store<PromptInputPersistedState> | Accessor<Store<PromptInputPersistedState>>,
  SetStoreFunction<PromptInputPersistedState>,
]

export type PromptInputStoreInput = PromptInputStoreTuple | Accessor<PromptInputStoreTuple>

export function createPromptInputStore(input: PromptInputStoreInput) {
  const tuple = () => (typeof input === "function" ? input() : input)
  const store = () => {
    const value = tuple()[0]
    return typeof value === "function" ? value() : value
  }
  const setStore = () => tuple()[1]

  return {
    get state() {
      return store()
    },
    setPrompt(prompt: PromptInputPrompt, cursor?: number) {
      batch(() => {
        setStore()("prompt", prompt)
        if (cursor !== undefined) setStore()("cursor", cursor)
      })
    },
    setCursor(cursor: number) {
      setStore()("cursor", cursor)
    },
    setText(content: string) {
      batch(() => {
        setStore()("prompt", (prompt) => [
          { type: "text", content, start: 0, end: content.length },
          ...prompt.filter((part) => part.type !== "text"),
        ])
        setStore()("cursor", content.length)
      })
    },
    addText(content: string) {
      const cursor = store().cursor ?? promptLength(store().prompt)
      batch(() => {
        setStore()("prompt", (prompt) => insertText(prompt, cursor, content))
        setStore()("cursor", cursor + content.length)
      })
    },
    reset() {
      batch(() => {
        setStore()("prompt", [{ type: "text", content: "", start: 0, end: 0 }])
        setStore()("cursor", 0)
      })
    },
    setModel(model: PromptInputModel | undefined) {
      setStore()("model", model)
    },
    setVariant(variant: string | null) {
      if (store().model) setStore()("model", "variant", variant)
    },
    addContext(item: PromptInputComment) {
      if (store().context.items.some((entry) => entry.key === item.key)) return
      setStore()("context", "items", (items) => [...items, item])
    },
    removeContext(key: string) {
      setStore()("context", "items", (items) => items.filter((item) => item.key !== key))
    },
    addMention(mention: PromptInputFilePart | PromptInputAgentPart) {
      const text = store()
        .prompt.map((part) => ("content" in part ? part.content : ""))
        .join("")
      const end = store().cursor ?? text.length
      const start = text.slice(0, end).lastIndexOf("@")
      setStore()("prompt", insertMention(store().prompt, start < 0 ? end : start, end, mention))
      setStore()("cursor", (start < 0 ? end : start) + mention.content.length + 1)
    },
    addAttachment(attachment: PromptInputAttachment) {
      setStore()("prompt", (prompt) => [...prompt, attachment])
    },
    removeAttachment(id: string) {
      setStore()("prompt", (parts) => parts.filter((part) => part.type !== "image" || part.id !== id))
    },
  }
}

export type PromptInputStore = ReturnType<typeof createPromptInputStore>

function insertText(prompt: PromptInputPrompt, cursor: number, content: string): PromptInputPrompt {
  let position = 0
  let inserted = false
  const parts = prompt.flatMap<PromptInputPrompt[number]>((part) => {
    if (part.type === "image") return [part]
    const start = position
    position += part.content.length
    if (inserted) return [part]
    if (part.type === "text" && cursor >= start && cursor <= position) {
      inserted = true
      const offset = cursor - start
      return [{ ...part, content: part.content.slice(0, offset) + content + part.content.slice(offset) }]
    }
    if (cursor > start) return [part]
    inserted = true
    return [{ type: "text", content, start: 0, end: 0 }, part]
  })
  if (!inserted) parts.push({ type: "text", content, start: 0, end: 0 })
  return withOffsets(parts)
}

function insertMention(
  prompt: PromptInputPrompt,
  start: number,
  end: number,
  mention: PromptInputFilePart | PromptInputAgentPart,
): PromptInputPrompt {
  let position = 0
  const parts = prompt.flatMap<PromptInputPrompt[number]>((part) => {
    if (part.type === "image") return [part]
    const partStart = position
    position += part.content.length
    if (part.type !== "text" || start < partStart || end > position) return [part]
    const before = part.content.slice(0, start - partStart)
    const after = part.content.slice(end - partStart)
    return [
      ...(before ? [{ type: "text" as const, content: before, start: 0, end: 0 }] : []),
      mention,
      { type: "text" as const, content: ` ${after}`, start: 0, end: 0 },
    ]
  })
  return withOffsets(parts)
}

function withOffsets(prompt: PromptInputPrompt): PromptInputPrompt {
  let offset = 0
  return prompt.map((part) => {
    if (part.type === "image") return part
    const next = { ...part, start: offset, end: offset + part.content.length }
    offset = next.end
    return next
  })
}

function promptLength(prompt: PromptInputPrompt) {
  return prompt.reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0)
}
