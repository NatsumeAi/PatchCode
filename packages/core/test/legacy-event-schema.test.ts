import { describe, expect, test } from "bun:test"
import { SessionWire as Wire } from "@opencode-ai/schema/session-legacy"
import { SessionWire } from "../src/session-legacy"

describe("legacy event schema compatibility", () => {
  test("Core references canonical SessionWire definitions", () => {
    expect(SessionWire.Event.Created).toBe(Wire.Event.Created)
    expect(SessionWire.Event.PartUpdated).toBe(Wire.Event.PartUpdated)
  })

  test("Core retains NamedError constructor identity", () => {
    const error = new SessionWire.APIError({ message: "failed", isRetryable: false })
    expect(error).toBeInstanceOf(SessionWire.APIError)
    expect(error.toObject()).toEqual({ name: "APIError", data: { message: "failed", isRetryable: false } })
  })
})
