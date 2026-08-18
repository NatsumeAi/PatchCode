export * as HooksRunHttp from "./run-http"

import { DeniedUrl, denyHost, guardUrl } from "../net/deny-host"
import type { Decision, Envelope, HttpHook, Origin } from "./schema"

export const runHttp = async (input: {
  hook: HttpHook
  envelope: Envelope
  origin: Origin
  hookId: string
  fetchImpl?: typeof fetch
}): Promise<Decision> => {
  const url = input.hook.url
  if (input.origin === "project") {
    let https = false
    try {
      https = new URL(url).protocol === "https:"
    } catch {
      return { _tag: "Deny", reason: "hook_failed", hookId: input.hookId }
    }
    if (!https || denyHost(url)) return { _tag: "Deny", reason: "hook_failed", hookId: input.hookId }
    try {
      await guardUrl(url)
    } catch (error) {
      if (error instanceof DeniedUrl || error instanceof Error) {
        return { _tag: "Deny", reason: "hook_failed", hookId: input.hookId }
      }
      return { _tag: "Deny", reason: "hook_failed", hookId: input.hookId }
    }
  }
  const timeoutMs = Math.max(1, input.hook.timeout) * 1000
  const fetchImpl = input.fetchImpl ?? fetch
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.envelope),
      signal: ac.signal,
    })
    if (response.status === 403) return { _tag: "Deny", reason: "denied", hookId: input.hookId }
    let body = ""
    try {
      body = await response.text()
    } catch {
      body = ""
    }
    if (body.trim().length === 0) {
      return response.ok ? { _tag: "Allow" } : { _tag: "Deny", reason: "hook_failed", hookId: input.hookId }
    }
    try {
      const parsed = JSON.parse(body) as { decision?: string; reason?: string }
      if (parsed.decision === "deny") return { _tag: "Deny", reason: parsed.reason || "denied", hookId: input.hookId }
      if (parsed.decision === "allow") return { _tag: "Allow" }
    } catch {
      return { _tag: "Deny", reason: "hook_failed", hookId: input.hookId }
    }
    return response.ok ? { _tag: "Allow" } : { _tag: "Deny", reason: "hook_failed", hookId: input.hookId }
  } catch {
    return { _tag: "Deny", reason: "hook_failed", hookId: input.hookId }
  } finally {
    clearTimeout(timer)
  }
}
