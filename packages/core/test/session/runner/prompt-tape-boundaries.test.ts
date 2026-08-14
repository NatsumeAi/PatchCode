import { afterEach, describe, expect, test } from "bun:test"
import { isPrefixOf } from "@opencode-ai/llm/cache-prefix"
import { PromptTape } from "@opencode-ai/core/session/runner/prompt-tape"
import { PromptTapeStore } from "@opencode-ai/core/session/runner/prompt-tape-store"

const tools = [{ type: "function" as const, function: { name: "echo", description: "e", parameters: {} } }]

afterEach(() => {
  PromptTapeStore.clearAll()
})

describe("PromptTape boundaries §3.6", () => {
  test("retry is identical compiled, not an append", () => {
    const tape = PromptTape.append(PromptTape.origin({ system: "S", tools }), [{ role: "user", content: "hi" }])
    expect(JSON.stringify(PromptTape.compiled(tape))).toBe(JSON.stringify(PromptTape.compiled(tape)))
  })

  test("parallel tool results stay in tool_calls order, not completion order", () => {
    const withAsst = PromptTape.append(PromptTape.origin({ system: "S", tools }), [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "slow", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "fast", arguments: "{}" } },
        ],
      },
    ])
    const withTools = PromptTape.append(withAsst, [
      { role: "tool", tool_call_id: "a", content: "slow-ok" },
      { role: "tool", tool_call_id: "b", content: "fast-ok" },
    ])
    const ids = withTools.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id)
    expect(ids).toEqual(["a", "b"])
  })

  test("provider-executed tool does not also append role:tool", () => {
    const tape = PromptTape.append(PromptTape.origin({ system: "S", tools }), [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "h", type: "function", function: { name: "hosted", arguments: "{}" } }],
      },
    ])
    expect(tape.messages.filter((m) => m.role === "tool")).toEqual([])
  })

  test("ephemeral verifier/timer is not on the next compiled", () => {
    const durable = PromptTape.append(PromptTape.origin({ system: "S", tools: undefined }), [
      { role: "user", content: "hi" },
    ])
    const withEphemeral = PromptTape.compiled(durable, [{ role: "user", content: '<verifier-feedback reason="x">' }])
    const next = PromptTape.compiled(durable)
    expect(JSON.stringify(withEphemeral)).not.toBe(JSON.stringify(next))
    expect(next.messages.some((m) => JSON.stringify(m).includes("verifier-feedback"))).toBe(false)
    expect(next.messages[0]).toEqual(withEphemeral.messages[0])
  })

  test("truncate then append remains a prefix through the boundary", () => {
    const t0 = PromptTape.append(PromptTape.origin({ system: "S", tools: undefined }), [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ])
    const truncated = PromptTape.truncate(t0, 2)
    const next = PromptTape.append(truncated, [{ role: "user", content: "u3" }])
    expect(isPrefixOf(PromptTape.wire(truncated), PromptTape.wire(next))).toBe(true)
    expect(isPrefixOf(PromptTape.wire(t0), PromptTape.wire(next))).toBe(false)
  })

  test("middle delete is not a prefix; hydrate is a new tape", () => {
    const t0 = PromptTape.append(PromptTape.origin({ system: "S", tools: undefined }), [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ])
    const holed = { ...t0, messages: [t0.messages[0]!, t0.messages[2]!] }
    expect(isPrefixOf(PromptTape.wire(t0), PromptTape.wire(holed))).toBe(false)
    const hydrated = PromptTape.origin({ system: t0.system, tools: t0.tools })
    const fresh = PromptTape.append(hydrated, holed.messages)
    expect(fresh.messages.map((m) => m.content)).toEqual(["u1", "u2"])
  })

  test("parent and child origins are different tapes", () => {
    const parent = PromptTape.origin({ system: "parent", tools })
    const child = PromptTape.origin({ system: "child-agent", tools: undefined })
    expect(parent.system).not.toBe(child.system)
    expect(isPrefixOf(PromptTape.wire(parent), PromptTape.wire(child))).toBe(false)
  })

  test("HTTP fork hydrates a prefix onto a new key, not the parent key", () => {
    const parent = PromptTape.append(PromptTape.origin({ system: "S", tools: undefined }), [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ])
    const child = PromptTape.append(
      PromptTape.origin({ system: parent.system, tools: parent.tools }),
      parent.messages.slice(0, 2),
    )
    expect(isPrefixOf(PromptTape.wire(child), PromptTape.wire(parent))).toBe(true)
    PromptTapeStore.set("parent", 1, parent)
    PromptTapeStore.set("child", 1, child)
    expect(PromptTapeStore.get("parent", 1)).not.toBe(PromptTapeStore.get("child", 1))
    expect(PromptTapeStore.get("parent", 1)!.messages.length).toBe(3)
  })

  test("extra tool at a second origin is not a prefix (MCP waits)", () => {
    const a = PromptTape.origin({ system: "S", tools })
    const b = PromptTape.origin({
      system: "S",
      tools: [...tools, { type: "function" as const, function: { name: "late", description: "l", parameters: {} } }],
    })
    expect(isPrefixOf(PromptTape.wire(a), PromptTape.wire(b))).toBe(false)
  })

  test("persona/system mutation after origin is ignored if compiled reads the tape", () => {
    const tape = PromptTape.origin({ system: "frozen", tools })
    const livePersona = "mutated"
    expect(PromptTape.compiled(tape).messages[0]!.content).toBe("frozen")
    expect(livePersona).not.toBe(tape.system)
  })

  test("skill body is a user append, not a system rewrite", () => {
    const origin = PromptTape.origin({ system: "S", tools: undefined })
    const next = PromptTape.append(origin, [{ role: "user", content: "<skill>body</skill>" }])
    expect(next.system).toBe("S")
    expect(isPrefixOf(PromptTape.wire(origin), PromptTape.wire(next))).toBe(true)
  })

  test("doom-loop abort does not rewrite messages[0]", () => {
    const tape = PromptTape.append(PromptTape.origin({ system: "S", tools: undefined }), [{ role: "user", content: "hi" }])
    const afterAbort = tape
    expect(afterAbort.system).toBe("S")
    expect(afterAbort.messages[0]).toEqual(tape.messages[0])
  })

  test("media URI is stable across appends", () => {
    const u = {
      role: "user" as const,
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
    }
    const t1 = PromptTape.append(PromptTape.origin({ system: "S", tools: undefined }), [u])
    const t2 = PromptTape.append(t1, [{ role: "assistant", content: "ok" }])
    expect(JSON.stringify(t2.messages[0])).toBe(JSON.stringify(t1.messages[0]))
  })

  test("store keys do not clobber sibling sessions", () => {
    PromptTapeStore.clearAll()
    PromptTapeStore.set("sesA", 1, PromptTape.origin({ system: "A", tools: undefined }))
    PromptTapeStore.set("sesB", 1, PromptTape.origin({ system: "B", tools: undefined }))
    expect(PromptTapeStore.get("sesA", 1)!.system).toBe("A")
    expect(PromptTapeStore.get("sesB", 1)!.system).toBe("B")
    PromptTapeStore.clear("sesA")
    expect(PromptTapeStore.get("sesA", 1)).toBeUndefined()
    expect(PromptTapeStore.get("sesB", 1)!.system).toBe("B")
  })

  test("clear does not treat session id as a prefix of another id", () => {
    PromptTapeStore.clearAll()
    PromptTapeStore.set("ses", 1, PromptTape.origin({ system: "one", tools: undefined }))
    PromptTapeStore.set("sesExtra", 1, PromptTape.origin({ system: "two", tools: undefined }))
    PromptTapeStore.clear("ses")
    expect(PromptTapeStore.get("sesExtra", 1)!.system).toBe("two")
  })

  test("empty assistant that was sent still grows messages", () => {
    const origin = PromptTape.origin({ system: "S", tools: undefined })
    const next = PromptTape.append(origin, [{ role: "assistant", content: "" }])
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]).toEqual({ role: "assistant", content: "" })
    expect(isPrefixOf(PromptTape.wire(origin), PromptTape.wire(next))).toBe(true)
  })

  test("reasoning bytes stay on the assistant part across appends", () => {
    const withReasoning = PromptTape.append(PromptTape.origin({ system: "S", tools: undefined }), [
      { role: "assistant", content: "ok", reasoning_content: "think" },
    ])
    const next = PromptTape.append(withReasoning, [{ role: "user", content: "more" }])
    expect(next.messages[0]).toMatchObject({ reasoning_content: "think" })
    expect(JSON.stringify(next.messages[0])).toBe(JSON.stringify(withReasoning.messages[0]))
  })

  test("half-open probe compiled equals last compiled", () => {
    const tape = PromptTape.append(PromptTape.origin({ system: "S", tools }), [{ role: "user", content: "probe" }])
    const last = PromptTape.compiled(tape)
    const probe = PromptTape.compiled(tape)
    expect(JSON.stringify(probe)).toBe(JSON.stringify(last))
  })

  test("compiled has no per-call max_tokens rewrite helper", () => {
    const compiled = PromptTape.compiled(PromptTape.origin({ system: "S", tools }))
    expect(JSON.stringify(compiled)).not.toContain("max_tokens")
    expect(JSON.stringify(compiled)).not.toContain("maxTokens")
  })

  test("child tapes are independent keys", () => {
    const parent = PromptTape.origin({ system: "parent", tools })
    const child = PromptTape.origin({ system: "child", tools })
    PromptTapeStore.set("parent", 1, parent)
    PromptTapeStore.set("child", 1, child)
    expect(PromptTapeStore.key("parent", 1)).not.toBe(PromptTapeStore.key("child", 1))
    expect(PromptTapeStore.get("parent", 1)!.system).toBe("parent")
    expect(PromptTapeStore.get("child", 1)!.system).toBe("child")
  })

  test("failover model change is a new origin, not a prefix", () => {
    const a = PromptTape.origin({ system: "S-model-a", tools })
    const b = PromptTape.origin({ system: "S-model-b", tools })
    expect(isPrefixOf(PromptTape.wire(a), PromptTape.wire(b))).toBe(false)
  })
})
