import { describe, expect, test } from "bun:test"
import { Net } from "../src/net/deny-host"

describe("Net.denyHost", () => {
  test("metadata and link-local URLs are denied", () => {
    expect(Net.denyHost("http://169.254.169.254/")).toBe(true)
    expect(Net.denyHost("http://169.254.169.254/latest/meta-data")).toBe(true)
    expect(Net.denyHost("169.254.1.1")).toBe(true)
    expect(Net.denyHost("http://metadata.google.internal/")).toBe(true)
  })

  test("loopback is denied", () => {
    expect(Net.denyHost("http://127.0.0.1/x.git")).toBe(true)
    expect(Net.denyHost("https://localhost/")).toBe(true)
    expect(Net.denyHost("http://[::1]/")).toBe(true)
    expect(Net.denyHost("http://0.0.0.0/")).toBe(true)
  })

  test("example.com is not denied", () => {
    expect(Net.denyHost("https://example.com")).toBe(false)
    expect(Net.denyHost("example.com")).toBe(false)
    expect(Net.denyHost("https://github.com/org/repo.git")).toBe(false)
  })

  test("empty host is not a deny", () => {
    expect(Net.denyHost("")).toBe(false)
    expect(Net.denyHost("/tmp/out")).toBe(false)
  })

  test("short and hex loopback forms are denied", () => {
    expect(Net.denyHost("127.1")).toBe(true)
    expect(Net.denyHost("0x7f.0.0.1")).toBe(true)
  })
})
