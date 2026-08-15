import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { Locale } from "./locale"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

type AssistantTime = AssistantMessage["time"] & { first?: number }

export function cacheHitRate(tokens: AssistantMessage["tokens"]): number {
  const read = tokens.cache.read
  const uncached = tokens.input
  const denom = read + uncached
  return denom === 0 ? 0 : read / denom
}

function partStart(part: Part): number | undefined {
  if (part.type === "text" || part.type === "reasoning") return part.time?.start
  if (part.type !== "tool") return
  const time = "time" in part.state ? part.state.time : undefined
  return time && "start" in time ? time.start : undefined
}

/** First model output (text, reasoning, or tool call) after the step started. */
export function firstTokenAt(message: AssistantMessage, parts: readonly Part[] = []): number | undefined {
  const stamped = (message.time as AssistantTime).first
  if (typeof stamped === "number" && stamped > message.time.created) return stamped
  let min: number | undefined
  for (const part of parts) {
    const start = partStart(part)
    if (typeof start !== "number" || start <= message.time.created) continue
    min = min === undefined ? start : Math.min(min, start)
  }
  return min
}

export function formatSessionUsageLine(input: {
  tokens: AssistantMessage["tokens"]
  contextLimit?: number
  cost: number
  created: number
  completed?: number
  firstTokenAt?: number
}): string | undefined {
  const tokens =
    input.tokens.input +
    input.tokens.output +
    input.tokens.reasoning +
    input.tokens.cache.read +
    input.tokens.cache.write
  if (tokens <= 0) return

  const pct =
    input.contextLimit && input.contextLimit > 0
      ? `${Math.round((tokens / input.contextLimit) * 100)}%`
      : undefined
  const genStart =
    input.firstTokenAt !== undefined && input.firstTokenAt > input.created
      ? input.firstTokenAt
      : input.created
  const ttfMs =
    input.firstTokenAt !== undefined && input.firstTokenAt > input.created
      ? input.firstTokenAt - input.created
      : undefined
  const tps =
    input.completed !== undefined && input.completed > genStart && input.tokens.output > 0
      ? input.tokens.output / ((input.completed - genStart) / 1000)
      : undefined

  return [
    pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens),
    `cache ${(cacheHitRate(input.tokens) * 100).toFixed(2)}%`,
    ttfMs !== undefined ? `TTF ${Locale.duration(ttfMs)}` : undefined,
    tps !== undefined ? `${tps.toFixed(2)} t/s` : undefined,
    input.cost > 0 ? money.format(input.cost) : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
}
