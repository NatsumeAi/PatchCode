import { describe, expect, test } from "bun:test"
import { runHttp } from "@opencode-ai/core/hooks"
import type { Envelope, HttpHook } from "@opencode-ai/core/hooks/schema"

const envelope: Envelope = {
  hookEventName: "PreToolUse",
  sessionId: "ses_http",
  cwd: "/",
  timestamp: new Date().toISOString(),
}

describe("W5 run-http", () => {
  test("project metadata IP is denied without fetch", async () => {
    let called = 0
    const decision = await runHttp({
      hook: { type: "http", url: "http://169.254.169.254/", timeout: 5 },
      envelope,
      origin: "project",
      hookId: "p:meta",
      fetchImpl: (async () => {
        called++
        return new Response("no")
      }) as typeof fetch,
    })
    expect(called).toBe(0)
    expect(decision._tag).toBe("Deny")
  })

  test("project loopback is rejected", async () => {
    let called = 0
    const decision = await runHttp({
      hook: { type: "http", url: "http://127.0.0.1/x", timeout: 5 },
      envelope,
      origin: "project",
      hookId: "p:loop",
      fetchImpl: (async () => {
        called++
        return new Response("no")
      }) as typeof fetch,
    })
    expect(called).toBe(0)
    expect(decision._tag).toBe("Deny")
  })

  test("global loopback is allowed to call", async () => {
    let called = 0
    const decision = await runHttp({
      hook: { type: "http", url: "http://127.0.0.1/x", timeout: 5 },
      envelope,
      origin: "global",
      hookId: "g:loop",
      fetchImpl: (async () => {
        called++
        return new Response(JSON.stringify({ decision: "allow" }), { status: 200 })
      }) as typeof fetch,
    })
    expect(called).toBe(1)
    expect(decision._tag).toBe("Allow")
  })

  test("403 is deny", async () => {
    const decision = await runHttp({
      hook: { type: "http", url: "https://example.com", timeout: 5 },
      envelope,
      origin: "project",
      hookId: "p:403",
      fetchImpl: (async () => new Response("no", { status: 403 })) as typeof fetch,
    })
    expect(decision._tag).toBe("Deny")
  })

  test("body deny", async () => {
    const decision = await runHttp({
      hook: { type: "http", url: "https://example.com", timeout: 5 },
      envelope,
      origin: "project",
      hookId: "p:body",
      fetchImpl: (async () => new Response(JSON.stringify({ decision: "deny" }), { status: 200 })) as typeof fetch,
    })
    expect(decision._tag).toBe("Deny")
  })

  test("timeout abort is deny", async () => {
    const decision = await runHttp({
      hook: { type: "http", url: "https://example.com", timeout: 1 },
      envelope,
      origin: "global",
      hookId: "g:timeout",
      fetchImpl: ((_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
        })) as typeof fetch,
    })
    expect(decision._tag).toBe("Deny")
  })
})
