import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { hitRate, isPrefixOf, stableHash, stableStringify, wireFromPrepared } from "../src/cache-prefix"

describe("cache-prefix", () => {
  test("stableStringify sorts object keys", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })

  test("isPrefixOf requires identical tools and messages prefix", () => {
    const a = {
      tools: [{ type: "function", function: { name: "echo", description: "e", parameters: {} } }],
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "hi" },
      ],
    }
    const b = {
      tools: a.tools,
      messages: [...a.messages, { role: "assistant", content: "ok" }],
    }
    expect(isPrefixOf(a, b)).toBe(true)
    expect(isPrefixOf(b, a)).toBe(false)
    expect(isPrefixOf({ ...a, tools: [] }, b)).toBe(false)
    expect(
      isPrefixOf(
        { ...a, messages: [{ role: "system", content: "S" }, { role: "user", content: "hi!" }] },
        b,
      ),
    ).toBe(false)
  })

  test("mutating an already-sent user is not a prefix", () => {
    const first = {
      tools: undefined,
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "Before." },
      ],
    }
    const merged = {
      tools: undefined,
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "Before.\n<system-update>\nX\n</system-update>" },
        { role: "user", content: "Next" },
      ],
    }
    const appended = {
      tools: undefined,
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "Before." },
        { role: "user", content: "<system-update>\nX\n</system-update>" },
        { role: "user", content: "Next" },
      ],
    }
    expect(isPrefixOf(first, merged)).toBe(false)
    expect(isPrefixOf(first, appended)).toBe(true)
  })

  test("hitRate is cache_read / (cache_read + uncached)", () => {
    expect(hitRate({ cacheReadInputTokens: 9985, nonCachedInputTokens: 15 })).toBeCloseTo(0.9985, 6)
    expect(hitRate({ cacheReadInputTokens: 0, nonCachedInputTokens: 0 })).toBe(0)
  })

  test("wireFromPrepared keeps tools and messages", () => {
    const body = {
      model: "x",
      messages: [{ role: "system", content: "S" }],
      tools: [{ type: "function", function: { name: "echo", description: "e", parameters: {} } }],
      stream: true as const,
    }
    expect(wireFromPrepared(body)).toEqual({ tools: body.tools, messages: body.messages })
  })

  test("stableHash is sha256 of stableStringify", () => {
    const value = { a: 1 }
    expect(stableHash(value)).toBe(createHash("sha256").update(stableStringify(value)).digest("hex"))
  })
})
