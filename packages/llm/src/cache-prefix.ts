import { createHash } from "node:crypto"

export const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    )
  }
  return value
}

export const stableStringify = (value: unknown) => JSON.stringify(canonicalize(value))

export const stableHash = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex")

export type ChatWire = {
  readonly tools?: unknown
  readonly messages: ReadonlyArray<unknown>
}

export const wireFromPrepared = (body: { readonly tools?: unknown; readonly messages: ReadonlyArray<unknown> }): ChatWire => ({
  tools: body.tools,
  messages: body.messages,
})

export const isPrefixOf = (prev: ChatWire, next: ChatWire) => {
  if (stableStringify(prev.tools) !== stableStringify(next.tools)) return false
  if (prev.messages.length > next.messages.length) return false
  return prev.messages.every((message, index) => stableStringify(message) === stableStringify(next.messages[index]))
}

export const hitRate = (usage: { readonly cacheReadInputTokens?: number; readonly nonCachedInputTokens?: number }) => {
  const read = usage.cacheReadInputTokens ?? 0
  const uncached = usage.nonCachedInputTokens ?? 0
  const denom = read + uncached
  return denom === 0 ? 0 : read / denom
}
