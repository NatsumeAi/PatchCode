import { describe, expect, test } from "bun:test"
import { isPrefixOf } from "@opencode-ai/llm/cache-prefix"
import { PromptTape } from "@opencode-ai/core/session/runner/prompt-tape"

const tools = [{ type: "function" as const, function: { name: "echo", description: "e", parameters: { type: "object" } } }]

describe("PromptTape", () => {
  test("origin freezes system and tools; append only grows messages", () => {
    const origin = PromptTape.origin({ system: "S", tools })
    const withUser = PromptTape.append(origin, [{ role: "user", content: "hi" }])
    const withAsst = PromptTape.append(withUser, [{ role: "assistant", content: "ok" }])
    expect(isPrefixOf(PromptTape.wire(origin), PromptTape.wire(withUser))).toBe(true)
    expect(isPrefixOf(PromptTape.wire(withUser), PromptTape.wire(withAsst))).toBe(true)
    expect(withUser.system).toBe("S")
    expect(withAsst.tools).toEqual(tools)
  })

  test("append copies; mutating the input array cannot rewrite the tape", () => {
    const origin = PromptTape.origin({ system: "S", tools })
    const extra = [{ role: "user" as const, content: "hi" }]
    const next = PromptTape.append(origin, extra)
    extra[0] = { role: "user", content: "rewritten" }
    expect(next.messages[0]).toEqual({ role: "user", content: "hi" })
  })

  test("ephemeral tail is not stored", () => {
    const origin = PromptTape.append(PromptTape.origin({ system: "S", tools }), [{ role: "user", content: "hi" }])
    const sent = PromptTape.withEphemeral(origin, [{ role: "user", content: "<verifier-feedback>" }])
    expect(sent.messages.at(-1)).toEqual({ role: "user", content: "<verifier-feedback>" })
    expect(origin.messages.at(-1)).toEqual({ role: "user", content: "hi" })
    expect(isPrefixOf(PromptTape.wire(origin), PromptTape.wire(sent))).toBe(true)
  })

  test("system-update must be a new user, not a merge", () => {
    const first = PromptTape.append(PromptTape.origin({ system: "S", tools: undefined }), [
      { role: "user", content: "Before." },
    ])
    const next = PromptTape.append(first, [{ role: "user", content: "<system-update>\nX\n</system-update>" }])
    expect(next.messages[0]).toEqual({ role: "user", content: "Before." })
    expect(isPrefixOf(PromptTape.wire(first), PromptTape.wire(next))).toBe(true)
  })

  test("compiled puts system first then conversation then ephemeral", () => {
    const tape = PromptTape.append(PromptTape.origin({ system: "S", tools }), [{ role: "user", content: "hi" }])
    const compiled = PromptTape.compiled(tape, [{ role: "user", content: "ephemeral" }])
    expect(compiled.protocol).toBe("openai-compatible-chat")
    expect(compiled.messages[0]).toEqual({ role: "system", content: "S" })
    expect(compiled.messages[1]).toEqual({ role: "user", content: "hi" })
    expect(compiled.messages[2]).toEqual({ role: "user", content: "ephemeral" })
    expect(compiled.tools).toEqual(tools)
  })
})
