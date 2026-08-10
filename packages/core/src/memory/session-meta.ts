import { Effect } from "effect"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { scanForThreats } from "./scan"

const MAX_TOPICS = 5
const MAX_TOPIC_CHARS = 200

export interface SessionMeta {
  readonly sessionID: string
  readonly date: string
  readonly userPrompts: number
  readonly userTextBytes: number
  readonly topics: string[]
  readonly assistantMessages: number
  readonly toolResults: number
}

/**
 * Sanitize a topic snippet for session metadata logs: clamp length, collapse
 * whitespace, drop threat-laden text (metadata-only privacy discipline).
 */
export function sanitizeTopic(text: string, maxChars = MAX_TOPIC_CHARS): string | undefined {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (collapsed.length === 0) return undefined
  const clipped = collapsed.slice(0, maxChars)
  if (scanForThreats(clipped).length > 0) return undefined
  return clipped
}

/** Zero-LLM metadata from session history: prompt counts, topics, sizes. */
export const extractSessionMeta = Effect.fn("Memory.extractSessionMeta")(function* (
  store: SessionStore.Interface,
  sessionID: SessionSchema.ID,
) {
  const messages = yield* store.context(sessionID)
  const topics: string[] = []
  let userPrompts = 0
  let userTextBytes = 0
  let assistantMessages = 0
  let toolResults = 0
  for (const message of messages) {
    if (message.type === "user") {
      const text = (message.text ?? "").trim()
      if (text.length > 0) {
        userTextBytes += text.length
        userPrompts++
        if (topics.length < MAX_TOPICS) {
          const topic = sanitizeTopic(text)
          if (topic !== undefined) topics.push(topic)
        }
      }
    } else if (message.type === "assistant") {
      assistantMessages++
      toolResults += message.content.filter((part) => part.type === "tool").length
    }
  }
  return {
    sessionID: String(sessionID),
    date: new Date().toISOString().slice(0, 10),
    userPrompts,
    userTextBytes,
    topics,
    assistantMessages,
    toolResults,
  }
})
