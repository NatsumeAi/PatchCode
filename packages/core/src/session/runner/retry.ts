export * as SessionRetry from "./retry"

import { iife } from "../../util/iife"

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://opencode.ai/go"

export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type RetryAction = {
  readonly reason: RetryReason
  readonly provider: string
  readonly title: string
  readonly message: string
  readonly label: string
  readonly link?: string
}

export type Retryable = {
  readonly message: string
  readonly action?: RetryAction
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000
export const RETRY_MAX_DELAY = 2_147_483_647

const cap = (ms: number) => Math.min(ms, RETRY_MAX_DELAY)

export type DelayError = {
  readonly responseHeaders?: Record<string, string | undefined>
}

/** Official leftover delay: Retry-After ms/seconds/HTTP-date, else exponential backoff. */
export function delay(attempt: number, error?: DelayError | { readonly data?: DelayError }) {
  if (error) {
    const headers = "responseHeaders" in error && error.responseHeaders ? error.responseHeaders : error.data?.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) return cap(parsedMs)
      }
      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) return cap(Math.ceil(parsedSeconds * 1000))
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) return cap(Math.ceil(parsed))
      }
      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, Math.max(0, attempt - 1)))
    }
  }
  return cap(
    Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, Math.max(0, attempt - 1)), RETRY_MAX_DELAY_NO_HEADERS),
  )
}

export type RetryableError = {
  readonly data?: {
    readonly statusCode?: number
    readonly isRetryable?: boolean
    readonly responseBody?: string
    readonly responseHeaders?: Record<string, string | undefined>
    readonly message?: string
  }
  readonly message?: string
  readonly name?: string
  readonly _tag?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const str = (value: unknown) => {
  if (value === undefined || value === null) return ""
  return String(value)
}

const num = (value: unknown) => {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

const parseJSON = (value: unknown) =>
  iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })

/** Official leftover retryable: Go upsell, 5xx always, rate-limit text. Context overflow is never retried. */
export function retryable(error: RetryableError, provider: string): Retryable | undefined {
  const tag = `${error._tag ?? ""} ${error.name ?? ""}`
  if (tag.includes("ContextOverflow")) return undefined

  const data = error.data
  const status = data?.statusCode
  if (data && data.isRetryable === false && !(status !== undefined && status >= 500)) return undefined

  if (data?.responseBody?.includes("FreeUsageLimitError")) {
    return {
      message: GO_UPSELL_MESSAGE,
      action: {
        reason: "free_tier_limit",
        provider,
        title: "Free limit reached",
        message: "Subscribe to OpenCode Go for reliable access to the best open-source models, starting at $5/month.",
        label: "subscribe",
        link: GO_UPSELL_URL,
      },
    }
  }
  if (data?.responseBody?.includes("GoUsageLimitError")) {
    const body = parseJSON(data.responseBody)
    const workspace = str(body?.metadata?.workspace)
    const limitName = str(body?.metadata?.limitName)
    const retryAfter = num(data.responseHeaders?.["retry-after"])
    const resetIn = iife(() => {
      if (retryAfter === undefined) return ""
      const seconds = Math.max(0, Math.ceil(retryAfter))
      const days = Math.floor(seconds / 86_400)
      const hours = Math.floor((seconds % 86_400) / 3_600)
      const minutes = Math.ceil((seconds % 3_600) / 60)
      const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`
      if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
      if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
      return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
    })
    const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`
    const link = `https://opencode.ai/workspace/${workspace}/go`
    return {
      message: `${message} - ${link}`,
      action: {
        reason: "account_rate_limit",
        provider,
        title: "Go limit reached",
        message,
        label: "open settings",
        link,
      },
    }
  }
  const msg = typeof data?.message === "string" ? data.message : typeof error.message === "string" ? error.message : undefined
  if (typeof msg === "string") {
    const json = parseJSON(msg)
    if (isRecord(json)) {
      const nested = isRecord(json.error) ? json.error : undefined
      const code = typeof json.code === "string" ? json.code : ""
      if (json.type === "error" && nested?.type === "too_many_requests") return { message: "Too Many Requests" }
      if (code.includes("exhausted") || code.includes("unavailable")) return { message: "Provider is overloaded" }
      if (json.type === "error" && typeof nested?.code === "string" && nested.code.includes("rate_limit")) {
        return { message: "Rate Limited" }
      }
      return undefined
    }
    if (msg.includes("Overloaded")) return { message: "Provider is overloaded" }
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return { message: msg }
    }
  }

  if (data?.isRetryable === true || (status !== undefined && status >= 500)) {
    return { message: typeof msg === "string" && msg.length > 0 ? msg : "Request failed" }
  }
  return undefined
}

export function retryAfterMsFrom(error: {
  readonly retryAfterMs?: number
  readonly responseHeaders?: Record<string, string | undefined>
  readonly data?: { readonly responseHeaders?: Record<string, string | undefined> }
}): number | undefined {
  if (error.retryAfterMs !== undefined && Number.isFinite(error.retryAfterMs)) return error.retryAfterMs
  const headers = error.responseHeaders ?? error.data?.responseHeaders
  if (!headers) return undefined
  const wait = delay(1, { responseHeaders: headers })
  return wait
}
