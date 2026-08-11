import { describe, expect, test } from "bun:test"
import { allowUnauthedMemoryMutation, isLoopbackAddress } from "../../src/memory/memory-http-guard"

describe("Memory HTTP mutation guard", () => {
  test("loopback addresses are recognized", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("::1")).toBe(true)
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("10.0.0.5")).toBe(false)
  })

  test("password configured always allows (auth middleware owns access)", () => {
    expect(allowUnauthedMemoryMutation({ passwordConfigured: true, remoteAddress: "10.0.0.5" })).toBe(true)
  })

  test("no password: loopback and missing peer allowed; remote denied", () => {
    const prev = process.env.OPENCODE_MEMORY_HTTP_OPEN
    delete process.env.OPENCODE_MEMORY_HTTP_OPEN
    expect(allowUnauthedMemoryMutation({ passwordConfigured: false, remoteAddress: "127.0.0.1" })).toBe(true)
    expect(allowUnauthedMemoryMutation({ passwordConfigured: false, remoteAddress: undefined })).toBe(true)
    expect(allowUnauthedMemoryMutation({ passwordConfigured: false, remoteAddress: "203.0.113.9" })).toBe(false)
    if (prev === undefined) delete process.env.OPENCODE_MEMORY_HTTP_OPEN
    else process.env.OPENCODE_MEMORY_HTTP_OPEN = prev
  })

  test("OPENCODE_MEMORY_HTTP_OPEN=1 allows remote without password", () => {
    const prev = process.env.OPENCODE_MEMORY_HTTP_OPEN
    process.env.OPENCODE_MEMORY_HTTP_OPEN = "1"
    expect(allowUnauthedMemoryMutation({ passwordConfigured: false, remoteAddress: "203.0.113.9" })).toBe(true)
    if (prev === undefined) delete process.env.OPENCODE_MEMORY_HTTP_OPEN
    else process.env.OPENCODE_MEMORY_HTTP_OPEN = prev
  })
})
