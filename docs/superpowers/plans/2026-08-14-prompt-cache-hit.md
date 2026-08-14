# Prompt Tape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One live drain. Put the append-only Chat tape on **that** drain (`SessionRunner`). Remove the **duplicate compile** only after a caller inventory proves it unused. Do not delete every symbol named V1. Then prove 99.85% on an armed ~100k-prefix Go Flash call — not `read > 0` on 5k.

**Architecture:** Live HTTP/TUI/command already call `SessionV2.prompt` → `SessionRunner`. Tape lives only there. SessionMessage is the UI log. Compaction starts a new tape. Prewarm is system-only. `SessionPrompt.runLoop` + `applyCaching` is the second **compile**, not “all V1.” Still-live V1-named modules (summary, permission compat, types, shell/llm if callers remain) stay until their callers move. Suffix rename (`SessionV2` → `Session`) is a later PR.

**Tech Stack:** TypeScript, Effect, Bun test, `LLMClient.prepare` / `generate` / `stream`, OpenAI-compatible Chat.

**Spec:** `docs/superpowers/specs/2026-08-14-prompt-cache-hit-design.md`

**Repo root:** `/home/huyongjun/openpartner/opencode`

## Global Constraints

- Never run tests from the repo root (`package.json` `"test"` exits 1). Use `bun --cwd packages/llm test …` and `bun --cwd packages/core test …`.
- Live models are the three allowlist rows. Helper throws on anything else.
- Live tests skip unless `LIVE_CACHE=1` (or `RECORD=true`) **and** a key (`OPENCODE_API_KEY` or `OPENCODE_GO_API_KEY` / `OPENCODE_ZEN_API_KEY`). Never commit keys.
- Offline CI does not assert `hit === 0.9985`. It asserts `isPrefixOf`.
- Live has two layers. Layer A (`LARGE_CACHEABLE_SYSTEM`, `read > 0`) proves the host reports cache. Layer B (~100k-token system, identical generation envelope, `hitRate >= 0.9985` with `uncached <= 200` and `inputTokens >= 80_000`) is the 99.85% claim. Do not claim 99.85% from Layer A.
- Warmup and scored live generates must share `temperature` / `max_tokens` / `tool_choice`. Do not set `maxTokens: 16` on only the second call.
- Do not persist verifier to make `isPrefixOf` green. Ephemeral tail is allowed to break full `isPrefixOf(N,N+1)`.
- Do not canonicalize model tool-argument JSON. Do not merge `<system-update>` into a previous user. Do not insert a dummy user for prewarm.
- Do not add Anthropic/OpenAI/Gemini live tests. `prompt_cache_key` and Anthropic `cache_control` are not this workstream’s hit strategy.
- **One compile.** Tape is implemented only on `packages/core/src/session/runner/llm.ts`. Do not add a second tape on `runLoop`.
- **Delete ≠ “name contains V1.”** Earlier session work kept some V1-named code and deleted some V2-named code. Inventory (`docs/superpowers/specs/2026-08-07-v1-runtime-inventory.md`) before any delete. Production caller remaining → stop and report; cut over first. Tests going red → migrate to the live drain or revert the delete.
- Wave D removes the **unused duplicate compile** (`runLoop` / `applyCaching` **when rg shows zero src callers**). It does not delete summary, permission compat, Message types, or `session/llm.ts` while they still stream. Suffix strip is not Wave D.
- Every row in spec §3.6 is in scope. Tool loop, subagent, resume, and retry are **four rows**, not the set. Also: HTTP fork, delete/update part, doom-loop (no `messages[0]` inject), circuit breaker, persona freeze, reasoning bytes, media-once, busy-session wait, harness-not-in-system, title/compact/memory sidecars, revert, steer, shell, permission/question, abort, model switch, overflow, envelope/TTL/stickiness.
- Append only after a successful stream. Retries resend **identical** `compiled`. `PromptTapeStore.clear` uses the full session id. Test `afterEach` → `clearAll()`.
- A green Wave A is required before Wave B. Wave B includes boundary CI (Task 9b) before claiming the runner tape is done. Wave C prewarm is required before scoring **turn-1** 99.85%. Without Layer B, do not claim 99.85%. “One compile” is claimed only after Wave D’s inventory is empty **and** the live suites stay green.
- No TBD / TODO / “similar to Task N” placeholders.

## Waves

| Wave | Tasks | Meaning |
|---|---|---|
| A | 1–4 | Measurement + compiled passthrough + PromptTape. Re-lowering is *cancelled* for compiled requests. |
| B | 5–9, **9b** | Runner sends the tape. Boundary CI for **every** §3.6 row (coverage matrix in Task 9b). |
| C | 10–13 | Persist, prewarm, compaction = new tape, live Go Flash, final gate. |
| D | 14 | Inventory, then delete **only** the unused duplicate compile. Keep still-live V1-named modules. No suffix rename in this wave. |

---

## Live model allowlist (hard rule)

| Role | Config id | Provider | Model | Base URL |
|---|---|---|---|---|
| **Primary, required** | `opencode-go/deepseek-v4-flash` | `opencode-go` | `deepseek-v4-flash` | `https://opencode.ai/zen/go/v1` |
| **Secondary, allowed** | `opencode/deepseek-v4-flash` | `opencode` | `deepseek-v4-flash` | `https://opencode.ai/zen/v1` |
| **Secondary, allowed** | `opencode/deepseek-v4-flash-free` | `opencode` | `deepseek-v4-flash-free` | `https://opencode.ai/zen/v1` |

---

## File map

| File | Responsibility |
|---|---|
| `packages/llm/src/cache-prefix.ts` | `isPrefixOf` / `hitRate` / `wireFromPrepared` over a Chat body |
| `packages/llm/src/schema/messages.ts` | `LLMRequest.compiled` |
| `packages/llm/src/protocols/openai-chat.ts` | Use `compiled` as the body; skip `lowerMessages` |
| `packages/llm/test/live/allowlist.ts` | The only place live models are constructed |
| `packages/core/src/session/runner/prompt-tape.ts` | Append-only tape; origin; ephemeral clone |
| `packages/core/src/session/runner/prompt-tape-append.ts` | Lower **new** events onto Chat messages (once) |
| `packages/core/src/session/runner/llm.ts` | Per-step send from tape |
| `packages/core/src/session/sql.ts` + migration | `tape_json` on `session_context_epoch` |
| `packages/core/src/session/runner/prewarm.ts` | System-only Go/Zen generate |

---

### Task 1: Prefix identity helpers

**Files:**
- Create: `packages/llm/src/cache-prefix.ts`
- Create: `packages/llm/test/cache-prefix.test.ts`
- Modify: `packages/llm/package.json` — add export `"./cache-prefix": "./src/cache-prefix.ts"`

**Interfaces:**
- Produces: `stableStringify`, `stableHash`, `isPrefixOf`, `hitRate`, `wireFromPrepared`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run — FAIL**

```bash
bun --cwd packages/llm test test/cache-prefix.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/llm/src/cache-prefix.ts`:

```ts
import { createHash } from "node:crypto"

export const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    )
  }
  return value
}

export const stableStringify = (value: unknown) => JSON.stringify(canonicalize(value))

export const stableHash = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex")

export type ChatWire = {
  readonly tools?: unknown
  readonly messages: ReadonlyArray<unknown>
}

export const wireFromPrepared = (body: { readonly tools?: unknown; readonly messages: ReadonlyArray<unknown> }): ChatWire => ({
  tools: body.tools,
  messages: body.messages,
})

export const isPrefixOf = (prev: ChatWire, next: ChatWire) => {
  if (stableStringify(prev.tools) !== stableStringify(next.tools)) return false
  if (prev.messages.length > next.messages.length) return false
  return prev.messages.every((message, index) => stableStringify(message) === stableStringify(next.messages[index]))
}

export const hitRate = (usage: { readonly cacheReadInputTokens?: number; readonly nonCachedInputTokens?: number }) => {
  const read = usage.cacheReadInputTokens ?? 0
  const uncached = usage.nonCachedInputTokens ?? 0
  const denom = read + uncached
  return denom === 0 ? 0 : read / denom
}
```

`canonicalize` here is **only** for hashing/comparison of wire JSON. Do not use it on model tool arguments before they go on the tape.

Add the package export.

- [ ] **Step 4: Run — PASS**

```bash
bun --cwd packages/llm test test/cache-prefix.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/cache-prefix.ts packages/llm/test/cache-prefix.test.ts packages/llm/package.json
git commit -m "$(cat <<'EOF'
feat(llm): add Chat wire prefix-identity helpers

Hit rate is arithmetic on a tape. CI asserts request N is a prefix of N+1.
EOF
)"
```

---

### Task 2: Live allowlist helper

**Files:**
- Create: `packages/llm/test/live/allowlist.ts`
- Create: `packages/llm/test/live/allowlist.test.ts`

**Interfaces:**
- Produces: `GO_FLASH`, `ZEN_FLASH`, `ZEN_FLASH_FREE`, `assertLiveModel`, `goApiKey`, `zenApiKey`, `liveEnabled`, `goModel`, `zenModel`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { assertLiveModel, GO_FLASH, ZEN_FLASH, ZEN_FLASH_FREE } from "./allowlist"

describe("live allowlist", () => {
  test("accepts the three rows", () => {
    expect(() => assertLiveModel(GO_FLASH)).not.toThrow()
    expect(() => assertLiveModel(ZEN_FLASH)).not.toThrow()
    expect(() => assertLiveModel(ZEN_FLASH_FREE)).not.toThrow()
  })

  test("throws on any other host or model", () => {
    expect(() =>
      assertLiveModel({
        providerID: "openai",
        modelID: "gpt-4o",
        baseURL: "https://api.openai.com/v1",
      }),
    ).toThrow(/allowlist/)
    expect(() =>
      assertLiveModel({
        providerID: "opencode-go",
        modelID: "deepseek-v4-flash",
        baseURL: "https://api.deepseek.com",
      }),
    ).toThrow(/allowlist/)
  })
})
```

- [ ] **Step 2: Run — FAIL**

```bash
bun --cwd packages/llm test test/live/allowlist.test.ts
```

- [ ] **Step 3: Implement**

```ts
import * as OpenAICompatible from "../../src/providers/openai-compatible"

export type LiveModelRef = {
  readonly providerID: string
  readonly modelID: string
  readonly baseURL: string
}

export const GO_FLASH: LiveModelRef = {
  providerID: "opencode-go",
  modelID: "deepseek-v4-flash",
  baseURL: "https://opencode.ai/zen/go/v1",
}

export const ZEN_FLASH: LiveModelRef = {
  providerID: "opencode",
  modelID: "deepseek-v4-flash",
  baseURL: "https://opencode.ai/zen/v1",
}

export const ZEN_FLASH_FREE: LiveModelRef = {
  providerID: "opencode",
  modelID: "deepseek-v4-flash-free",
  baseURL: "https://opencode.ai/zen/v1",
}

const ALLOWED: ReadonlyArray<LiveModelRef> = [GO_FLASH, ZEN_FLASH, ZEN_FLASH_FREE]

export const assertLiveModel = (ref: LiveModelRef) => {
  const ok = ALLOWED.some(
    (row) => row.providerID === ref.providerID && row.modelID === ref.modelID && row.baseURL === ref.baseURL,
  )
  if (!ok) throw new Error(`live allowlist rejected ${ref.providerID}/${ref.modelID} @ ${ref.baseURL}`)
}

export const liveEnabled = () => process.env.LIVE_CACHE === "1" || process.env.RECORD === "true"

export const goApiKey = () => process.env.OPENCODE_GO_API_KEY || process.env.OPENCODE_API_KEY

export const zenApiKey = () => process.env.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_API_KEY

export const goModel = () => {
  assertLiveModel(GO_FLASH)
  return OpenAICompatible.configure({
    provider: GO_FLASH.providerID,
    baseURL: GO_FLASH.baseURL,
    apiKey: goApiKey() ?? "missing",
  }).model(GO_FLASH.modelID)
}

export const zenModel = (free = false) => {
  const ref = free ? ZEN_FLASH_FREE : ZEN_FLASH
  assertLiveModel(ref)
  const allowed = process.env.OPENCODE_ZEN_CACHE_MODEL
  if (allowed && allowed !== ref.modelID) throw new Error(`OPENCODE_ZEN_CACHE_MODEL rejected: ${allowed}`)
  return OpenAICompatible.configure({
    provider: ref.providerID,
    baseURL: ref.baseURL,
    apiKey: zenApiKey() ?? "missing",
  }).model(ref.modelID)
}
```

If `OpenAICompatible.configure` field names differ, match `packages/llm/src/providers/openai-compatible.ts` exactly.

- [ ] **Step 4: Run — PASS**

```bash
bun --cwd packages/llm test test/live/allowlist.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/llm/test/live/allowlist.ts packages/llm/test/live/allowlist.test.ts
git commit -m "$(cat <<'EOF'
test(llm): lock Go/Zen Flash as the only live cache models
EOF
)"
```

---

### Task 3: Cancel re-lowering — `LLMRequest.compiled`

When `compiled.protocol === "openai-compatible-chat"`, Chat `fromRequest` copies `compiled.messages` / `compiled.tools` onto the body. It does **not** call `lowerMessages` or `lowerTool`. That is the architectural break.

**Files:**
- Modify: `packages/llm/src/schema/messages.ts` (`LLMRequest` + `LLMRequest.input`)
- Modify: `packages/llm/src/protocols/openai-chat.ts` (`fromRequest`)
- Modify: `packages/llm/test/provider/openai-chat.test.ts`

**Interfaces:**
- Produces: `LLMRequest.compiled?: { protocol: "openai-compatible-chat"; messages: unknown[]; tools?: unknown }`

- [ ] **Step 1: Write the failing test** (add to `openai-chat.test.ts`)

```ts
  it.effect("compiled chat body is sent without merging system-update into the previous user", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          prompt: "this prompt must not appear on the wire",
          compiled: {
            protocol: "openai-compatible-chat",
            messages: [
              { role: "system", content: "S" },
              { role: "user", content: "Before." },
              { role: "user", content: "<system-update>\nX\n</system-update>" },
            ],
            tools: [{ type: "function", function: { name: "echo", description: "e", parameters: { type: "object" } } }],
          },
        }),
      )
      expect(prepared.body.messages).toEqual([
        { role: "system", content: "S" },
        { role: "user", content: "Before." },
        { role: "user", content: "<system-update>\nX\n</system-update>" },
      ])
      expect(prepared.body.messages.some((message) => JSON.stringify(message).includes("this prompt must not appear"))).toBe(
        false,
      )
      expect(prepared.body.tools).toEqual([
        { type: "function", function: { name: "echo", description: "e", parameters: { type: "object" } } },
      ])
    }),
  )

  it.effect("compiled preserves exact tool-call argument strings", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
        LLM.request({
          model,
          prompt: "ignored",
          compiled: {
            protocol: "openai-compatible-chat",
            messages: [
              { role: "system", content: "S" },
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "echo", arguments: '{"zed":1,"alpha":2}' },
                  },
                ],
              },
            ],
          },
        }),
      )
      const assistant = prepared.body.messages[1] as {
        tool_calls: Array<{ function: { arguments: string } }>
      }
      expect(assistant.tool_calls[0]!.function.arguments).toBe('{"zed":1,"alpha":2}')
    }),
  )
```

Without `compiled` on `LLMRequest`, this fails to typecheck/construct. Keep the existing test that merge still happens on the **non-compiled** path — that path is not the runner.

- [ ] **Step 2: Run — FAIL**

```bash
bun --cwd packages/llm test test/provider/openai-chat.test.ts
```

- [ ] **Step 3: Implement**

In `packages/llm/src/schema/messages.ts`, add before `LLMRequest`:

```ts
export const CompiledChat = Schema.Struct({
  protocol: Schema.Literal("openai-compatible-chat"),
  messages: Schema.Array(Schema.Unknown),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
})
export type CompiledChat = Schema.Schema.Type<typeof CompiledChat>
```

Add to the `LLMRequest` class fields:

```ts
compiled: Schema.optional(CompiledChat),
```

Add `compiled: request.compiled` to `LLMRequest.input`.

In `OpenAIChat.fromRequest`, **first lines**:

```ts
const fromRequest = Effect.fn("OpenAIChat.fromRequest")(function* (request: LLMRequest) {
  const generation = request.generation
  if (request.compiled?.protocol === "openai-compatible-chat") {
    return {
      model: request.model.id,
      messages: request.compiled.messages,
      tools: request.compiled.tools,
      tool_choice: request.toolChoice ? yield* lowerToolChoice(request.toolChoice) : undefined,
      stream: true as const,
      stream_options: { include_usage: true },
      max_tokens: generation?.maxTokens,
      temperature: generation?.temperature,
      top_p: generation?.topP,
      frequency_penalty: generation?.frequencyPenalty,
      presence_penalty: generation?.presencePenalty,
      seed: generation?.seed,
      stop: generation?.stop,
      ...(yield* lowerOptions(request)),
    }
  }
  // existing lowerMessages / lowerTool path unchanged
```

`LLM.request` already forwards unknown `RequestInput` fields through `...rest`; `compiled` will land on the class once the schema field exists. `LLM.updateRequest` must keep `compiled` via `LLMRequest.input`.

- [ ] **Step 4: Run — PASS**

```bash
bun --cwd packages/llm test test/provider/openai-chat.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/schema/messages.ts packages/llm/src/protocols/openai-chat.ts packages/llm/test/provider/openai-chat.test.ts
git commit -m "$(cat <<'EOF'
feat(llm): send compiled Chat bodies without re-lowering

Runner tape bytes must reach the host unchanged. lowerMessages is not
the production path when compiled is set.
EOF
)"
```

---

### Task 4: PromptTape (append-only)

Pure module. No DB yet. Mutating a past message must be impossible through the public API.

**Files:**
- Create: `packages/core/src/session/runner/prompt-tape.ts`
- Create: `packages/core/test/session/runner/prompt-tape.test.ts`

**Interfaces:**
- Produces: `PromptTape.origin`, `PromptTape.append`, `PromptTape.withEphemeral`, `PromptTape.compiled`, `PromptTape.isPrefixOf`

- [ ] **Step 1: Write the failing test**

```ts
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
```

If core tests cannot import `@opencode-ai/core/session/runner/prompt-tape`, use a relative import from the test file matching neighboring tests.

- [ ] **Step 2: Run — FAIL**

```bash
bun --cwd packages/core test test/session/runner/prompt-tape.test.ts
```

- [ ] **Step 3: Implement** `packages/core/src/session/runner/prompt-tape.ts`

```ts
export * as PromptTape from "./prompt-tape"

import type { CompiledChat } from "@opencode-ai/llm"
import { isPrefixOf as wireIsPrefixOf, type ChatWire } from "@opencode-ai/llm/cache-prefix"

export type ChatMessage = {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content?: unknown
  readonly tool_calls?: unknown
  readonly tool_call_id?: string
  readonly reasoning_content?: string
}

export type ChatTool = {
  readonly type: "function"
  readonly function: { readonly name: string; readonly description: string; readonly parameters: unknown }
}

export interface Tape {
  readonly system: string
  readonly tools: ReadonlyArray<ChatTool> | undefined
  readonly messages: ReadonlyArray<ChatMessage>
}

const cloneMessages = (messages: ReadonlyArray<ChatMessage>) =>
  messages.map((message) => structuredClone(message)) as ChatMessage[]

export const origin = (input: { readonly system: string; readonly tools: ReadonlyArray<ChatTool> | undefined }): Tape => ({
  system: input.system,
  tools: input.tools === undefined ? undefined : structuredClone(input.tools) as ChatTool[],
  messages: [],
})

export const append = (tape: Tape, extra: ReadonlyArray<ChatMessage>): Tape => ({
  system: tape.system,
  tools: tape.tools,
  messages: [...tape.messages, ...cloneMessages(extra)],
})

export const withEphemeral = (tape: Tape, extra: ReadonlyArray<ChatMessage>): Tape => append(tape, extra)

export const wire = (tape: Tape): ChatWire => ({
  tools: tape.tools,
  messages: [{ role: "system", content: tape.system }, ...tape.messages],
})

export const compiled = (tape: Tape, ephemeral: ReadonlyArray<ChatMessage> = []): CompiledChat => ({
  protocol: "openai-compatible-chat",
  messages: [{ role: "system", content: tape.system }, ...tape.messages, ...cloneMessages(ephemeral)],
  tools: tape.tools,
})

export const isPrefixOf = (prev: Tape, next: Tape) => wireIsPrefixOf(wire(prev), wire(next))
```

If `CompiledChat` is not exported from `@opencode-ai/llm` yet, export it from `packages/llm/src/schema/messages.ts` (already added in Task 3).

Do **not** put a setter for `system` or `tools`.

- [ ] **Step 4: Run — PASS**

```bash
bun --cwd packages/core test test/session/runner/prompt-tape.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/runner/prompt-tape.ts packages/core/test/session/runner/prompt-tape.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add append-only PromptTape

System and tools are origin-only. Conversation only grows. Ephemeral
tails are request clones, not stored history.
EOF
)"
```

---

### Task 5: Lower new events once (not the whole store)

This is the only remaining “lowering.” It runs when an event is born, then the Chat message is on the tape forever.

**Files:**
- Create: `packages/core/src/session/runner/prompt-tape-append.ts`
- Create: `packages/core/test/session/runner/prompt-tape-append.test.ts`
- Modify: `packages/core/src/session/runner/to-llm-message.ts` only if a small helper is reused; do **not** call `toLLMMessages` on the full store from the per-step path.

**Interfaces:**
- Produces: `lowerUser`, `lowerSystemUpdate`, `lowerAssistantFromStream`, `lowerToolResult`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import * as Append from "@opencode-ai/core/session/runner/prompt-tape-append"

describe("prompt-tape-append", () => {
  test("system update is a new user message, never merged", () => {
    expect(Append.lowerSystemUpdate("AGENTS.md changed")).toEqual({
      role: "user",
      content: "<system-update>\nAGENTS.md changed\n</system-update>",
    })
  })

  test("assistant keeps the exact streamed arguments string", () => {
    const message = Append.lowerAssistantFromStream({
      text: null,
      toolCalls: [{ id: "c1", name: "echo", arguments: '{"zed":1,"alpha":2}' }],
    })
    expect(message).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: '{"zed":1,"alpha":2}' } }],
    })
  })

  test("user inlines data URIs and does not rewrite them", () => {
    const message = Append.lowerUser({
      text: "see",
      files: [{ mime: "image/png", uri: "data:image/png;base64,aaa", name: "a.png" }],
    })
    expect(message.role).toBe("user")
    expect(JSON.stringify(message)).toContain("data:image/png;base64,aaa")
  })
})
```

- [ ] **Step 2: Run — FAIL**

```bash
bun --cwd packages/core test test/session/runner/prompt-tape-append.test.ts
```

- [ ] **Step 3: Implement**

Use `ProviderShared.wrapSystemUpdate` from `packages/llm/src/protocols/shared.ts` (exported). Do not concatenate into a previous user.

```ts
import { ProviderShared } from "@opencode-ai/llm/protocols/openai-chat"
```

If `ProviderShared` is not re-exported from that path, import from the module the neighboring runner files use, or:

```ts
import { wrapSystemUpdate } from "@opencode-ai/llm/src/protocols/shared"
```

Match an existing core import of llm protocol helpers. The wrapper is:

```ts
export const lowerSystemUpdate = (text: string) => ({
  role: "user" as const,
  content: wrapSystemUpdate([{ text }]),
})

export const lowerAssistantFromStream = (input: {
  readonly text: string | null
  readonly toolCalls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly arguments: string }>
  readonly reasoning?: string
}) => ({
  role: "assistant" as const,
  content: input.text,
  tool_calls:
    input.toolCalls.length === 0
      ? undefined
      : input.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        })),
  ...(input.reasoning ? { reasoning_content: input.reasoning } : {}),
})

export const lowerToolResult = (input: { readonly toolCallId: string; readonly content: string }) => ({
  role: "tool" as const,
  tool_call_id: input.toolCallId,
  content: input.content,
})

export const lowerUser = (input: {
  readonly text: string
  readonly files?: ReadonlyArray<{ readonly uri: string; readonly mime: string; readonly name?: string }>
}) => {
  const files = input.files ?? []
  if (files.length === 0) return { role: "user" as const, content: input.text }
  return {
    role: "user" as const,
    content: [
      { type: "text" as const, text: input.text },
      ...files.map((file) => ({
        type: "image_url" as const,
        image_url: { url: file.uri },
      })),
    ],
  }
}
```

`file://` inlining belongs in the runner at append time (read once, pass `data:` into `lowerUser`). This module must not re-read disk.

Escape: copy `escapeSystemUpdateText` from `packages/llm/src/protocols/shared.ts` if it is not exported.

- [ ] **Step 4: Run — PASS**

```bash
bun --cwd packages/core test test/session/runner/prompt-tape-append.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/runner/prompt-tape-append.ts packages/core/test/session/runner/prompt-tape-append.test.ts
git commit -m "$(cat <<'EOF'
feat(core): lower new tape events once

System updates are new users. Tool arguments stay the streamed string.
EOF
)"
```

---

### Task 6: Runner origin — build system+tools once, send `compiled`

Replace the per-step `LLM.request({ system: [agent, baseline, persona, verifier], messages: toLLMMessages(context), tools: materialize() })` with tape origin + compiled send.

**Files:**
- Modify: `packages/core/src/session/runner/llm.ts`
- Modify: `packages/core/src/tool/registry.ts` — name-sort definitions at materialize (wire order only needs to be stable at origin; sorting here makes origin deterministic)
- Create: `packages/core/src/session/runner/prompt-tape-store.ts` (process Map keyed by `` `${session.id}:${baselineSeq}` ``)
- Modify: `packages/core/test/session-runner.test.ts`

**Interfaces:**
- Consumes: `PromptTape.origin`, `PromptTape.compiled`, `PromptTape.append`
- Produces: per-epoch tape in the store; runner `LLMRequest.compiled`

Process Map:

```ts
const tapes = new Map<string, PromptTape.Tape>()
export const key = (sessionID: string, baselineSeq: number) => `${sessionID}:${baselineSeq}`
export const get = (sessionID: string, baselineSeq: number) => tapes.get(key(sessionID, baselineSeq))
export const set = (sessionID: string, baselineSeq: number, tape: PromptTape.Tape) => {
  tapes.set(key(sessionID, baselineSeq), tape)
}
export const clear = (sessionID: string) => {
  for (const item of [...tapes.keys()]) if (item.startsWith(`${sessionID}:`)) tapes.delete(item)
}
export const clearAll = () => tapes.clear()
```

`clear` must use the full session id, never the `"ses"` prefix. `afterEach` in `session-runner.test.ts` calls `PromptTapeStore.clearAll()`.

- [ ] **Step 1: Failing runner test**

In `session-runner.test.ts`, add (after the echo-tool loop pattern already in the file — copy its `LLMEvent.toolCall` / `resume` sequence exactly if this snippet’s event list does not compile):

```ts
  it.effect("second tool-loop request compiled body is a prefix of the first", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Echo once" }), resume: false })
      requests.length = 0
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hi" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]
      yield* session.resume(sessionID)
      const turnRequests = requests.filter((request) => !isTitleRequest(request))
      expect(turnRequests.length).toBeGreaterThanOrEqual(2)
      expect(turnRequests[0]!.compiled?.protocol).toBe("openai-compatible-chat")
      const first = yield* LLMClient.prepare(turnRequests[0]!)
      const second = yield* LLMClient.prepare(turnRequests[1]!)
      expect(isPrefixOf(wireFromPrepared(first.body), wireFromPrepared(second.body))).toBe(true)
    }),
  )
```

Import `LLMClient` from `@opencode-ai/llm/route` (real `prepare`, not the mock). Import `isPrefixOf`, `wireFromPrepared` from `@opencode-ai/llm/cache-prefix`. Use the file’s existing `isTitleRequest`.

This **fails today** because there is no `compiled` and the body is re-lowered from the store (and last-step / tools / verifier can bust). After Tasks 6–8 it must pass.

- [ ] **Step 2: Run — FAIL**

```bash
bun --cwd packages/core test test/session-runner.test.ts
```

Expected: FAIL (`compiled` undefined and/or `isPrefixOf` false).

- [ ] **Step 3: Implement origin + send**

In `registry.ts` `materialize`, after building `definitions`:

```ts
definitions.sort((a, b) => a.name.localeCompare(b.name))
```

In `llm.ts` `runTurnAttempt`, replace the per-step join/materialize/toLLMMessages request build.

Origin (when `PromptTapeStore.get` is missing):

```ts
const personaSystem = yield* PersonaInject.systemTextForSession(session.id).pipe(
  Effect.catch(() => Effect.succeed(undefined as string | undefined)),
)
const toolMaterialization = yield* tools.materialize(agent.info)
const systemText = [agent.info?.system, system.baseline, personaSystem]
  .filter((part): part is string => part !== undefined && part.length > 0)
  .join("\n")
const originRequest = LLM.request({
  model,
  system: systemText,
  tools: toolMaterialization.definitions,
  messages: [],
})
const preparedOrigin = yield* LLMClient.prepare(originRequest)
const tape0 = PromptTape.origin({
  system: systemText,
  tools: preparedOrigin.body.tools as PromptTape.ChatTool[] | undefined,
})
PromptTapeStore.set(session.id, system.baselineSeq, tape0)
PromptTapeStore.setSettle(session.id, system.baselineSeq, toolMaterialization.settle)
```

Need `LLMClient` in the runner (already has `llm` service). `prepare` may need to be called on `LLMClient` from `@opencode-ai/llm/route` inside Effect. If the runner’s `llm` service has no `prepare`, import `LLMClient.prepare` from `@opencode-ai/llm/route` — it is a pure compile of the request.

Every step after origin:

1. Load tape.
2. Append **new** durable Chat messages since last send (user just admitted, ContextUpdated, completed tool results, last assistant from stream — Task 7–8 fill these appends). For this task, a minimal version that hydrates **once** from `toLLMMessages` **only when the tape is empty of conversation and the store already has history** (session resume mid-epoch) is allowed as a bootstrap. The per-step path after that must append, not re-hydrate.
3. Build ephemeral (empty until Task 7).
4. Send:

```ts
const request = LLM.request({
  model,
  system: tape.system,
  tools: toolMaterialization?.definitions ?? [],
  messages: [],
  toolChoice: isLastStep ? "none" : undefined,
  compiled: PromptTape.compiled(tape, ephemeral),
})
```

**Last step:** do **not** pass `tools: []`. Use origin tools on the tape. `isLastStep` no longer skips `materialize` for the wire; it only sets `toolChoice` and ephemeral `MAX_STEPS`. If origin already ran, skip rematerialize entirely.

Keep `toolMaterialization.settle` from the store for execution. After process restart (Task 10) rematerialize **for settle only**.

Do not put verifier in `systemText`.

`LLMClient.prepare` on a request with `compiled` (Task 3) is what the new test uses.

- [ ] **Step 4: Run**

```bash
bun --cwd packages/core test test/session-runner.test.ts
```

Expected: the new prefix test may still fail until Tasks 7–8 append assistant/tool bytes. Origin/`compiled` should exist. Fix compile errors. Do not weaken the prefix assertion.

- [ ] **Step 5: Commit** (even if the prefix test is still red, only if you temporarily `it.effect.skip` that one test with a comment `// unskip in Task 8`. Prefer leaving it failing and not committing a skip. If the suite cannot be committed red, skip **only** that one test and unskip in Task 8.)

```bash
git add packages/core/src/session/runner/llm.ts packages/core/src/session/runner/prompt-tape-store.ts packages/core/src/tool/registry.ts packages/core/test/session-runner.test.ts
git commit -m "$(cat <<'EOF'
feat(core): send runner Chat requests from a PromptTape

Epoch origin writes system and tools once. Per-step path uses compiled
bodies instead of joining live system parts.
EOF
)"
```

---

### Task 7: Volatile is this-turn user

Verifier, timer, recall, ContextUpdated — never system after origin.

**Files:**
- Modify: `packages/core/src/session/runner/llm.ts`
- Modify: `packages/core/test/session-runner.test.ts` (the existing verifier test around “drains one verifier-reject feedback into the next turn's system context”)

- [ ] **Step 1: Change the existing verifier test** (this is the new contract)

Replace the expectations that `secondSystem` has length 2 with:

```ts
expect(requests[0]!.compiled).toBeDefined()
const messages = requests[0]!.compiled!.messages as Array<{ role: string; content?: unknown }>
expect(messages[0]).toEqual({ role: "system", content: expect.stringContaining("Initial context") })
expect(messages.filter((message) => message.role === "system")).toHaveLength(1)
const lastUser = [...messages].reverse().find((message) => message.role === "user")
expect(JSON.stringify(lastUser)).toContain("Reject reason one")
expect(JSON.stringify(lastUser)).toContain("src/a.ts:7 — null guard missing")
```

Third resume: that verifier user is **gone** (ephemeral). System still one part, no reject text in `compiled.messages[0]`.

Transcript assertions stay: no `Reject reason one`, no `verifier-feedback`.

Rename the test to: `"drains one verifier-reject into an ephemeral trailing user and out of the durable transcript"`.

- [ ] **Step 2: Run — FAIL** (verifier still in system / not in compiled tail)

```bash
bun --cwd packages/core test test/session-runner.test.ts
```

- [ ] **Step 3: Implement**

`renderVerifierFeedback` stays. Call site:

```ts
const verifierFeedback = renderVerifierFeedback(yield* drain.verifierBiDirectional.getNextTurnSystemContext)
const ephemeral: PromptTape.ChatMessage[] = []
if (verifierFeedback.length > 0) ephemeral.push({ role: "user", content: verifierFeedback })
if (isLastStep) ephemeral.push({ role: "assistant", content: MAX_STEPS_PROMPT })
```

Do **not** `PromptTape.append` verifier. Do **not** add it to `systemText`.

Recall: stop combining `core/memory-recall` into `SystemContext` in `loadSystemContextAndRecall`. If recall text is non-empty, `PromptTape.append` a user message at origin (durable) via `Append.lowerUser({ text: recall })`. If a later prepare would have been `ReplacementReady` because recall went empty, append `Append.lowerUser({ text: "(memory recall cleared)" })` instead of rebuilding baseline. Do not add `removed` as a system rewrite.

ContextUpdated: when `prepare` publishes it, the projector already appends a SessionMessage.System. On the tape, when you see a new system session message since last cursor, `PromptTape.append(tape, [Append.lowerSystemUpdate(text)])`. Never pass `Message.system` through Chat `lowerMessages`.

- [ ] **Step 4: Run — PASS** for the verifier test. Prefix test may still fail until Task 8.

```bash
bun --cwd packages/core test test/session-runner.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/runner/llm.ts packages/core/test/session-runner.test.ts
git commit -m "$(cat <<'EOF'
fix(core): put verifier, recall, and context updates on the user tail

Changing system mid-epoch breaks the Chat prefix. Ephemeral verifier is
not persisted on the tape or in the transcript.
EOF
)"
```

---

### Task 8: Stream bytes onto the tape; unskip prefix CI

After a successful stream, append the assistant using **delta accumulator strings**, then tool results as they settle. Do not `JSON.stringify(event.input)`.

**Files:**
- Modify: `packages/core/src/session/runner/llm.ts` (stream loop)
- Modify: `packages/core/src/session/runner/publish-llm-event.ts` only if you must expose the accumulator; prefer capturing deltas in `runTurnAttempt` where `llm.stream` is consumed
- Unskip Task 6 prefix test

- [ ] **Step 1: Unit test for arguments identity** (add to `prompt-tape-append.test.ts`)

```ts
  test("JSON.stringify of parsed input is not used", () => {
    const streamed = '{"zed":1,"alpha":2}'
    const message = Append.lowerAssistantFromStream({
      text: null,
      toolCalls: [{ id: "c1", name: "echo", arguments: streamed }],
    })
    const parsed = JSON.parse(streamed) as { zed: number; alpha: number }
    expect(message.tool_calls![0]!.function.arguments).toBe(streamed)
    expect(message.tool_calls![0]!.function.arguments).not.toBe(JSON.stringify(parsed))
  })
```

In JS `JSON.stringify({zed:1,alpha:2})` may equal the streamed string; use streamed `'{"zed": 1, "alpha": 2}'` (spaces) so stringify diverges:

```ts
    const streamed = '{"zed": 1, "alpha": 2}'
    ...
    expect(message.tool_calls![0]!.function.arguments).not.toBe(JSON.stringify(JSON.parse(streamed)))
```

- [ ] **Step 2: Run that test — PASS** (function already exists). Then unskip the runner prefix test and run:

```bash
bun --cwd packages/core test test/session-runner.test.ts test/session/runner/prompt-tape-append.test.ts
```

Expected: prefix test FAIL until the stream append is wired.

- [ ] **Step 3: Implement capture**

In the `Stream.runForEach` of `runTurnAttempt`, accumulate:

```ts
const argumentText = new Map<string, string>()
const toolNames = new Map<string, string>()
let assistantText = ""
```

On `tool-input-start`: `toolNames.set(event.id, event.name); argumentText.set(event.id, "")`
On `tool-input-delta`: `argumentText.set(event.id, (argumentText.get(event.id) ?? "") + event.text)`
On `text-delta`: `assistantText += event.text`
On `step-finish` / successful end of the attempt: 

```ts
const calls = [...argumentText.entries()].map(([id, args]) => ({
  id,
  name: toolNames.get(id) ?? "",
  arguments: args,
}))
PromptTapeStore.set(
  session.id,
  system.baselineSeq,
  PromptTape.append(PromptTapeStore.get(session.id, system.baselineSeq)!, [
    Append.lowerAssistantFromStream({
      text: assistantText.length ? assistantText : null,
      toolCalls: calls,
    }),
  ]),
)
```

When a local tool settles, append `Append.lowerToolResult({ toolCallId, content: framedOnce })`. Frame with the existing `frameToolResult` **once**.

New user: when `entriesForRunner` contains a user with seq > tape cursor, `lowerUser` (inline `file://` once via existing `mediaMaterializer` **for that message only**), append, advance cursor. Store cursor on the tape store (`lastSeq`).

Do not call `toLLMMessages` on the full list in this loop.

- [ ] **Step 4: Run — PASS** including the Task 6 prefix test

```bash
bun --cwd packages/core test test/session-runner.test.ts test/session/runner/prompt-tape-append.test.ts
```

Add a negative in `prompt-tape.test.ts` if missing: shuffling tools on a copy is not a prefix (already in Task 1).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/runner/llm.ts packages/core/src/session/runner/prompt-tape-store.ts packages/core/test/session-runner.test.ts packages/core/test/session/runner/prompt-tape-append.test.ts
git commit -m "$(cat <<'EOF'
feat(core): append streamed Chat bytes onto the PromptTape

The next request resends the same assistant tool arguments the model
emitted, then the new tail. No full-store re-lowering.
EOF
)"
```

---

### Task 9: Negatives + last-step tools stay

**Files:**
- Modify: `packages/core/test/session/runner/prompt-tape.test.ts`
- Modify: `packages/core/test/session-runner.test.ts`

- [ ] **Step 1: Tests**

```ts
  test("rewriting system is not a prefix", () => {
    const a = PromptTape.origin({ system: "S", tools: undefined })
    const b = PromptTape.origin({ system: "S2", tools: undefined })
    expect(PromptTape.isPrefixOf(a, b)).toBe(false)
  })
```

Runner: find or add a last-step fixture (`agent.info.steps`). Assert `compiled.tools` is still a non-empty array (or equal to the previous request’s tools) when `toolChoice` is `"none"`.

If no last-step test exists, add one that sets the build agent `steps: 1` after a tool call would be needed, and check `turnRequests.at(-1)!.compiled!.tools` is defined and `turnRequests.at(-1)!.toolChoice` is none.

- [ ] **Step 2: Run — FAIL** if last-step still omits tools

```bash
bun --cwd packages/core test test/session-runner.test.ts test/session/runner/prompt-tape.test.ts
```

- [ ] **Step 3: Fix last-step** so it does not set `toolMaterialization = undefined` for the wire. Tape tools stay. `MAX_STEPS` is ephemeral assistant (Task 7).

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session/runner/llm.ts packages/core/test/session-runner.test.ts packages/core/test/session/runner/prompt-tape.test.ts
git commit -m "$(cat <<'EOF'
fix(core): keep epoch tools on the last Chat step

Omitting tools rewrites the prefix. Cap the loop with tool_choice/none
and an ephemeral MAX_STEPS tail.
EOF
)"
```

---

### Task 9b: Every cache-moving path (spec §3.6)

Not “tool loop + resume + retry” only. Spec §3.6 is the checklist. This task **must** leave a coverage matrix with no blank rows. Sidecar probes (title, compact, memory, verifier-model) must **not** write `PromptTapeStore`.

**Files:**
- Modify: `packages/core/src/session/runner/prompt-tape.ts` (`truncate`; optional `ephemeral`)
- Modify: `packages/core/test/session/runner/prompt-tape.test.ts`
- Create: `packages/core/test/session/runner/prompt-tape-boundaries.test.ts`
- Modify: `packages/core/test/session-runner.test.ts`
- Modify: `packages/core/src/session/runner/llm.ts` (retry identical; append after success; title/sidecar isolation)

**Interfaces:**
- Consumes: `PromptTape.origin/append/truncate/compiled`, `PromptTapeStore.get/set/clear/clearAll`
- Produces: tests that lock §3.6 A–C + “no tape write” rows

#### Coverage matrix (no blank rows)

| §3.6 row | Where the test lives |
|---|---|
| Tool loop N→N+1 | Task 8 growing-loop `isPrefixOf` |
| Parallel tools call-order | 9b Step 1 |
| Provider-executed tools (no duplicate `role: tool`) | 9b Step 1 |
| Permission / question wait | 9b Step 2 (deny then continue; compiled prefix holds) |
| Interrupt / decline mid-tools | 9b Step 2 (no partial assistant on tape) |
| Last-step keeps tools | Task 9 |
| Verifier / timer ephemeral | Task 7 + 9b Step 1 (`ephemeral` not in next `compiled`) |
| Steer / queue | 9b Step 2 |
| `/command` / `init` | same as user append (Task 6) |
| `noReply` / `projectUser` | 9b Step 2: `resume: false` does not origin; `projectUser` appends if on wire |
| Shell | 9b Step 2: next compiled has one extra user-shaped shell, system/tools unchanged |
| Synthetic / peer_message | 9b Step 1: append user on **target** tape only |
| ContextUpdated / recall | Task 7 |
| Grace budget | same tape (Task 8 loop) |
| `session.resume` | 9b Step 2 |
| Process restart | Task 10 `tape_json` |
| HTTP 429 / W1 retry / idle-timeout retry | 9b Step 2 identical `compiled` |
| MCP/plugin tools wait next epoch | 9b Step 1: second `origin` with extra tool is **not** prefix of first |
| Plugin/skill not in system | 9b Step 1: skill body as user append; system hash unchanged |
| Circuit breaker Open | 9b Step 2: Open → no second `llm.stream` |
| HalfOpen probe identical | 9b Step 1: probe compiled === last compiled |
| Doom-loop no `messages[0]` inject | 9b Step 1 + Step 2: after doom abort, tape.system / messages[0] unchanged |
| Tree budget / 24h timer / abort | tape stays (9b Step 2 interrupt) |
| `/loop` / goal seed | 9b Step 2: after drain, `compiled.messages[0]` has no goal/timer dump |
| Persona frozen at origin | 9b Step 1: mutating persona string after origin does not change `compiled` |
| Reasoning bytes | Task 8 exact stream; 9b Step 1 keeps reasoning part |
| Media once | Task 5 append; 9b Step 1: same `data:` URI on step 2 |
| Rapid-fire users | 9b Step 2: two users, one origin, two appends |
| Auth / content_policy no retry | existing classifier tests + 9b: tape.messages length unchanged |
| Concurrent session keys | 9b Step 1: `store.set(a)` does not overwrite `store.get(b)` |
| Crash / no partial append | W1 retry identical (9b Step 2) |
| Envelope freeze | Task 12 live; 9b Step 1: compiled has no per-call max_tokens rewrite helper |
| Empty assistant that was sent | 9b Step 1: append `content: ""` still grows messages |
| SubagentFailed parent abort | 9b Step 2 if suite has parentID; parent tape has no child system |
| Child cap independent | Task 9 on child session if spawned; else 9b Step 1 two tapes |
| Revert / unrevert / delete last | 9b Step 1 truncate + Step 2 revert |
| Delete middle / deletePart / updatePart | 9b Step 1: hole → `isPrefixOf` false; hydrate new tape |
| Overflow / manual compact | Task 12 |
| Agent / model / variant switch | 9b Step 2: after `switchModel`, new origin (system or tools may change); first compiled not prefix of previous |
| Failover model change | new tape (9b Step 1 different origin) |
| ReplacementBlocked | tape unchanged (Task 12) |
| HTTP fork | 9b Step 1: child tape key ≠ parent; hydrate prefix once |
| Busy compact/revert/fork | 9b Step 2: SessionBusy → store snapshot unchanged |
| Compaction hoist forbidden on hot path | Task 8: per-step does not call `toLLMMessages` |
| Subagent spawn / ForkMode / task_id resume | 9b Step 2 child key; Task 6 origin per session |
| Title sidecar | 9b Step 2 |
| Memory / compact summarizer / project-copy / verifier LLM | 9b Step 1: calling those helpers must not `PromptTapeStore.set` session key (spy or post-condition) |
| session.update / share / diffs / list/get | 9b Step 2: title patch leaves tape bytes identical |
| Worktree child | child’s origin (same as spawn) |
| `prompt_async` | same drain as prompt (no extra test if HTTP already uses V2) |
| Session.create empty | no origin until first generate (Task 6) |
| Host block / TTL / stickiness / huge tool result | Task 12 probes (D), not offline 99.85 |

- [ ] **Step 1: Pure tape tests** in `packages/core/test/session/runner/prompt-tape-boundaries.test.ts`

```ts
import { describe, expect, test } from "bun:test"
import { isPrefixOf } from "@opencode-ai/llm/cache-prefix"
import { PromptTape } from "@opencode-ai/core/session/runner/prompt-tape"
import { PromptTapeStore } from "@opencode-ai/core/session/runner/prompt-tape-store"

const tools = [{ type: "function" as const, function: { name: "echo", description: "e", parameters: {} } }]

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
    const withEphemeral = PromptTape.compiled(durable, [{ role: "user", content: "<verifier-feedback reason=\"x\">" }])
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
    const child = PromptTape.append(PromptTape.origin({ system: parent.system, tools: parent.tools }), parent.messages.slice(0, 2))
    expect(isPrefixOf(PromptTape.wire(child), PromptTape.wire(parent))).toBe(true)
    PromptTapeStore.set("parent:1", parent)
    PromptTapeStore.set("child:1", child)
    expect(PromptTapeStore.get("parent:1")).not.toBe(PromptTapeStore.get("child:1"))
    expect(PromptTapeStore.get("parent:1")!.messages.length).toBe(3)
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
    const u = { role: "user" as const, content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }] }
    const t1 = PromptTape.append(PromptTape.origin({ system: "S", tools: undefined }), [u])
    const t2 = PromptTape.append(t1, [{ role: "assistant", content: "ok" }])
    expect(JSON.stringify(t2.messages[0])).toBe(JSON.stringify(t1.messages[0]))
  })

  test("store keys do not clobber sibling sessions", () => {
    PromptTapeStore.clearAll()
    PromptTapeStore.set("sesA:1", PromptTape.origin({ system: "A", tools: undefined }))
    PromptTapeStore.set("sesB:1", PromptTape.origin({ system: "B", tools: undefined }))
    expect(PromptTapeStore.get("sesA:1")!.system).toBe("A")
    expect(PromptTapeStore.get("sesB:1")!.system).toBe("B")
    PromptTapeStore.clear("sesA:1")
    expect(PromptTapeStore.get("sesA:1")).toBeUndefined()
    expect(PromptTapeStore.get("sesB:1")!.system).toBe("B")
  })

  test("clear does not treat session id as a prefix of another id", () => {
    PromptTapeStore.clearAll()
    PromptTapeStore.set("ses:1", PromptTape.origin({ system: "one", tools: undefined }))
    PromptTapeStore.set("sesExtra:1", PromptTape.origin({ system: "two", tools: undefined }))
    PromptTapeStore.clear("ses:1")
    expect(PromptTapeStore.get("sesExtra:1")!.system).toBe("two")
  })
})
```

`compiled(tape, ephemeral = [])` is already positional from Task 4. This task only adds `truncate(tape, keep)`: `{ ...tape, messages: tape.messages.slice(0, keep) }`. Do not mutate in place. Ephemeral stays off `tape.messages`.

`PromptTapeStore.clear(key)` deletes that exact key. `clear("ses")` must **not** delete `"sesExtra:1"`. `afterEach` in this file calls `PromptTapeStore.clearAll()`.

- [ ] **Step 2: Runner tests** in `session-runner.test.ts` (copy existing echo/resume patterns; filter `isTitleRequest`)

1. **W1 retry identical:** mock stream fails once before any assistant event, then succeeds. `turnRequests` length ≥ 2. `JSON.stringify(compiled[0]) === JSON.stringify(compiled[1])`.
2. **Resume does not re-origin:** prompt → settle → `session.resume` with a new user. Second `messages[0]` equals first. `isPrefixOf` true.
3. **Title sidecar:** after `ensureTitle`, session tape has no “Generate a title for this conversation”.
4. **Steer append:** compiled grows by one user; system/tools unchanged.
5. **Child session:** child’s `compiled.messages[0]` ≠ parent’s system. Store keys differ.
6. **Shell:** after `session.shell`, next generate’s durable messages include the shell block once; system unchanged.
7. **Interrupt mid-tools:** abort during unsettled tools; tape has no half-built assistant **or** has the chosen failed-tool messages, and resume is a prefix of that choice (pick one in implementation, lock it here).
8. **Permission deny:** deny once, continue; next compiled is prefix+one tool error.
9. **switchModel:** next origin is a new tape (`isPrefixOf` with previous compiled is false unless model bytes are identical — they will not be if tools/system change; always new `baselineSeq` / new key).
10. **Doom-loop / breaker Open:** force abort; no further stream; `messages[0]` still the origin system (no reminder).
11. **Goal seed / timer:** `compiled.messages[0]` does not contain `Goal       :` or `<harness-timer-reminder>` (timer is ephemeral trailing user only).
12. **Busy revert:** revert while running → busy error; tape bytes unchanged until idle.
13. **session.update title:** patch title; `PromptTapeStore.get` system/messages unchanged.
14. **noReply:** `resume: false` does not call origin if a tape already exists.
15. **content_policy:** one stream, no second request, tape.messages length unchanged.
16. **Rapid-fire:** two users admitted before settle; one origin; two user appends in order.

- [ ] **Step 3: Run — FAIL** until truncate / ephemeral compiled / retry-identical / title isolation / exact-key clear exist

```bash
bun --cwd packages/core test test/session/runner/prompt-tape-boundaries.test.ts test/session/runner/prompt-tape.test.ts test/session-runner.test.ts
```

- [ ] **Step 4: Implement**

- `PromptTape.truncate`; keep Task 4 `compiled(tape, ephemeral?)`
- `runTurnAttempt`: capture `compiled` before `llm.stream`; on W1 `continue`, send **that same object**; `PromptTape.append` only after `stream._tag === "Success"`
- `ensureTitle` / compact summarizer / memory: do not call `PromptTapeStore.set` on the session key
- Revert commit: `PromptTape.truncate` to the boundary
- Child / HTTP fork: `origin` uses **that** `session.id`
- `PromptTapeStore.clear(fullKey)` exact match; `clearAll` for tests
- Timer/verifier: pass as `ephemeral`, never `tape.system`
- Doom-loop / breaker: stop without rewriting messages[0]

- [ ] **Step 5: Run — PASS** then commit

```bash
git add packages/core/src/session/runner/prompt-tape.ts packages/core/src/session/runner/prompt-tape-store.ts packages/core/src/session/runner/llm.ts packages/core/test/session/runner/prompt-tape.test.ts packages/core/test/session/runner/prompt-tape-boundaries.test.ts packages/core/test/session-runner.test.ts
git commit -m "$(cat <<'EOF'
test(core): lock every PromptTape boundary in spec §3.6

Retry is identical compiled. Resume does not re-origin. Title, compact,
and memory never write the session tape. Revert truncates. Fork and
children get new keys. Harness signals stay out of messages[0].
EOF
)"
```

Host-only rows (DeepSeek block alignment, idle TTL, KV stickiness, huge tool-result dip) stay on Task 12. They still have a tape rule in the spec; they are not “skipped.”

---

### Task 10: Persist `tape_json` (Wave C)

**Files:**
- Modify: `packages/core/src/session/sql.ts` (`SessionContextEpochTable`)
- Run: `bun --cwd packages/core script/migration.ts --name add_epoch_prompt_tape`
- Modify: `packages/core/src/session/context-epoch.ts`
- Modify: `packages/core/src/session/runner/prompt-tape-store.ts`
- Modify: `packages/core/test/database-migration.test.ts` only if it snapshots columns

Column: `tape_json` text json, nullable.

- [ ] **Step 1:** Add the drizzle column, generate migration, write a test that origin then `clearAll()` then `get` reloads identical `system` / `tools` / `messages` from the epoch row.

- [ ] **Step 2: Run — FAIL** (column missing / reload empty)

```bash
bun --cwd packages/core script/migration.ts --name add_epoch_prompt_tape
bun --cwd packages/core test test/session/runner/prompt-tape.test.ts
```

- [ ] **Step 3:** On `PromptTapeStore.set`, also `update session_context_epoch set tape_json = ?`. On `get` miss, `select tape_json`. `settle` is not persisted; rematerialize by name after reload.

- [ ] **Step 4: Run — PASS** plus

```bash
bun --cwd packages/core test test/database-migration.test.ts
```

- [ ] **Step 5: Commit** including generated migration files.

```bash
git commit -m "$(cat <<'EOF'
feat(core): persist PromptTape on the context epoch row

Restart must resend the same Chat prefix, not rehydrate from SessionMessage.
EOF
)"
```

---

### Task 11: Prewarm (system-only)

**Files:**
- Create: `packages/core/src/session/runner/prewarm.ts`
- Create: `packages/core/test/session/runner/prewarm.test.ts`
- Modify: `packages/core/src/session/runner/llm.ts` (call after origin, fire-and-forget)

- [ ] **Step 1: Test**

```ts
import { describe, expect, test } from "bun:test"
import { PromptTape } from "@opencode-ai/core/session/runner/prompt-tape"
import { prewarmRequest } from "@opencode-ai/core/session/runner/prewarm"

test("prewarm compiled messages are system only", () => {
  const tape = PromptTape.origin({
    system: "S",
    tools: [{ type: "function", function: { name: "echo", description: "e", parameters: {} } }],
  })
  const request = prewarmRequest(model, tape)
  expect(request.compiled!.messages).toEqual([{ role: "system", content: "S" }])
  expect(request.compiled!.messages.some((message) => (message as { role: string }).role === "user")).toBe(false)
  expect(request.generation?.maxTokens).toBe(1)
})
```

`model` = same `Model.make` as `session-runner-message.test.ts`.

- [ ] **Step 2: Run — FAIL**

```bash
bun --cwd packages/core test test/session/runner/prewarm.test.ts
```

- [ ] **Step 3: Implement**

```ts
export const prewarmRequest = (model: Model, tape: PromptTape.Tape) =>
  LLM.request({
    model,
    system: tape.system,
    messages: [],
    compiled: PromptTape.compiled(tape),
    generation: { maxTokens: 1, temperature: 0 },
  })
```

`PromptTape.compiled(tape)` with empty conversation is `[system]`. Schedule `llm.generate(prewarmRequest(...))` after origin only if `model.provider` is `opencode-go` or `opencode` and id is one of the three allowlisted model ids. Catch errors; never write a user onto the tape. Do not block the user turn.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(core): prewarm Go/Zen Chat KV with system+tools only

No dummy user. If the host rejects system-only, skip; do not poison the tape.
EOF
)"
```

---

### Task 12: Compaction starts a new tape + live Go Flash

**Files:**
- Modify: `packages/core/src/session/runner/llm.ts` (on `continueAfterCompaction` / epoch replace: `PromptTapeStore.clear(session.id)` then origin on the new baselineSeq)
- Modify: `packages/core/src/session/compaction.ts` — summarizer `LLM.request` keeps its own system; set `cache: "none"` on that request (Anthropic adapter; harmless on Chat)
- Create: `packages/core/test/session/runner/cache-hit.live.test.ts`
- Modify: `packages/core/test/session-runner.test.ts` if a compaction test asserts same system array identity across compact (it should still get a **new** compiled prefix after compact; `isPrefixOf(pre, post)` is **false** and that is required)

**Live tests** (skip unless `LIVE_CACHE=1` and `goApiKey()`):

Copy `GO_FLASH` / `goApiKey` / `liveEnabled` into this file (do not import from `packages/llm/test`). `skipIf(!(liveEnabled() && goApiKey()))`.

Shared envelope for every generate in this file (warmup and scored **identical**):

```ts
const ENVELOPE = { maxTokens: 16, temperature: 0 } as const
const go = (request: LLMRequest) => LLM.updateRequest(request, { model: goFlash, generation: ENVELOPE })
```

Never `{ ...request, model }`. Never set `maxTokens` on only the second call.

`LONG_CACHEABLE_SYSTEM` — 99.85% demonstration size, **not** the 250-repeat 5k fixture:

```ts
const LONG_CACHEABLE_SYSTEM = (() => {
  const sentence = "You are a concise, factual assistant. Answer precisely and avoid filler. Cite numbers when known. "
  // ~100 chars × 4000 ≈ 400k chars ≈ 100k tokens
  return sentence.repeat(4000)
})()
```

Keep `LARGE_CACHEABLE_SYSTEM` (250 repeats) only for Layer A.

**Layer A** (host lights up; not the 99.85% claim):

1. Tape with `system: LARGE_CACHEABLE_SYSTEM`.
2. `generate(go(compiled))`, append `{ role: "user", content: "ping" }`, `generate` again with the **same** envelope.
3. `expect(second.usage?.cacheReadInputTokens ?? 0).toBeGreaterThan(0)`.
4. `expect(isPrefixOf(wireFromPrepared(firstBody), wireFromPrepared(secondBody))).toBe(true)`.

**Layer B** (the 99.85% claim; this is the extreme test):

```ts
const origin = PromptTape.origin({ system: LONG_CACHEABLE_SYSTEM, tools: echoTools })
const warmupReq = go(LLM.request({ model: goFlash, system: origin.system, messages: [], compiled: PromptTape.compiled(origin), generation: ENVELOPE }))
const warmup = yield* LLMClient.generate(warmupReq)
const scoredTape = PromptTape.append(origin, [{ role: "user", content: "ok" }])
const scoredReq = go(LLM.request({ model: goFlash, system: scoredTape.system, messages: [], compiled: PromptTape.compiled(scoredTape), generation: ENVELOPE }))
const scored = yield* LLMClient.generate(scoredReq)
const read = scored.usage?.cacheReadInputTokens ?? 0
const uncached = scored.usage?.nonCachedInputTokens ?? 0
const input = scored.usage?.inputTokens ?? read + uncached
const rate = hitRate({ cacheReadInputTokens: read, nonCachedInputTokens: uncached })
expect(input).toBeGreaterThanOrEqual(80_000)
expect(read).toBeGreaterThan(0)
expect(uncached).toBeLessThanOrEqual(200)
expect(rate).toBeGreaterThanOrEqual(0.9985)
const preparedW = yield* LLMClient.prepare(warmupReq)
const preparedS = yield* LLMClient.prepare(scoredReq)
expect(isPrefixOf(wireFromPrepared(preparedW.body), wireFromPrepared(preparedS.body))).toBe(true)
```

If the host’s block size makes `rate` land at e.g. 0.9982 with `uncached` 160 on a 100k input: **do not** rewrite the assertion to `read > 0`. Record `read/uncached/input/rate` in the spec Risks section and keep `uncached <= 200` plus `input >= 80_000`. Only if `uncached > 200` is the tape busted.

Optional: system-only prewarm (`PromptTape.compiled(origin)` with empty conversation, `maxTokens: 1` — this envelope **differs**; it is not the scored pair). Then scored first user call with `ENVELOPE`. If `read > 0` and `rate >= 0.9985`, turn-1 99.85% is proven. If the host rejects system-only or does not carry that KV into `system+user`, skip this case; Layer B warmup+append still stands.

**Runner-shaped Layer B:** same numbers from SessionRunner `compiled` after setting `agent.system` or `systemBaseline` to `LONG_CACHEABLE_SYSTEM`. Capture two turn requests, `go()` both with `ENVELOPE`, generate in order. Hand-built Layer B without runner-shaped Layer B is not enough to claim production 99.85%.

Probe (not the claim): same prefix, only `tool_choice: "none"` on the second generate. Record whether `cache_read` drops. Do not change production last-step policy unless it drops **and** you then stop sending `toolChoice: "none"` on the cap step.

Layer B sends ~100k input twice. `LIVE_CACHE=1` only. Offline: skip, exit 0.

```bash
LIVE_CACHE=1 bun --cwd packages/core test test/session/runner/cache-hit.live.test.ts
```

- [ ] **Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(core): new PromptTape on compaction; live-score Go Flash tape hits

Compaction is a new epoch, not a patch on the old prefix. 99.85% is a
~100k-prefix live score, not read>0 on 5k.
EOF
)"
```

---

### Task 13: Log + final gate

**Files:**
- Modify: `packages/core/src/session/runner/llm.ts` — after `Step.Ended`, log `cache_hit steady=${hitRate(usage)} read=${read} uncached=${uncached}`
- Modify spec Risks with the armed probe numbers when you have them

- [ ] **Offline**

```bash
cd /home/huyongjun/openpartner/opencode
bun --cwd packages/llm test \
  test/cache-prefix.test.ts \
  test/live/allowlist.test.ts \
  test/provider/openai-chat.test.ts
bun --cwd packages/core test \
  test/session/runner/prompt-tape.test.ts \
  test/session/runner/prompt-tape-append.test.ts \
  test/session/runner/prewarm.test.ts \
  test/session-runner.test.ts \
  test/session-runner-message.test.ts \
  test/database-migration.test.ts
```

Expected: PASS.

- [ ] **Live**

```bash
LIVE_CACHE=1 bun --cwd packages/core test test/session/runner/cache-hit.live.test.ts
```

Expected: PASS, or skip if no key. Layer A `read > 0` is not the 99.85% claim. **Without Layer B (`input >= 80k`, `uncached <= 200`, `hitRate >= 0.9985` on runner-shaped compiled) do not claim 99.85%.**

- [ ] Confirm `git grep` on new live tests: no `api.anthropic.com`, `api.openai.com`, `generativelanguage`, `api.deepseek.com`.

- [ ] **Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(core): log steady-state Chat cache hit from tape sends
EOF
)"
```

---

### Task 14: Inventory, then remove only the unused duplicate compile (Wave D)

Not “delete V1.” Session work already **kept** some V1-named modules and **dropped** some V2-named ones. Suffixes come off later. This task only removes a **second way to build the provider prompt**, and only after `rg` shows it has no production callers.

Authority: `docs/superpowers/specs/2026-08-07-v1-runtime-inventory.md` + a fresh `rg` in this task.

**Do not delete in this task (still-live or compat unless inventory updates):**

- `SessionSummary`
- Instance `Permission.Service` (V1-named compat)
- Message / part types TUI still imports
- `SessionRevert` **registration** until its tests are migrated
- `SessionPrompt.shell` / `SessionProcessor` if any `src/` caller remains
- `packages/opencode/src/session/llm.ts` / `llm/native-runtime.ts` while `app-runtime.ts` or HTTP still construct that `LLM` service (they still do as of 2026-08-14)

**Delete candidates (only if Step 1 is empty):**

- `SessionPrompt.runLoop` / `SessionPrompt.prompt` as an LLM drain
- `applyCaching` **and** its `ProviderTransform.message` branch, only if no remaining stream uses `session/llm.ts`
- Per-turn `new Date()` in `system.ts` **only if** `environment()` has no remaining callers
- `prompt.test.ts` cases that exist solely to keep `runLoop` green — rewrite onto `SessionV2.prompt` or drop

- [ ] **Step 1: Inventory table (write into the spec Risks / a short note in this file)**

```bash
rg -n "SessionPrompt\\.(prompt|loop|run)|runLoop|applyCaching|ProviderTransform\\.message|from \\\"@/session/llm\\\"" \
  packages/opencode/src packages/tui/src packages/app/src packages/core/src
```

Fill:

| Symbol | Production callers | Keep / cut-over / delete |
|---|---|---|
| `runLoop` / `SessionPrompt.prompt` | | |
| `applyCaching` via `session/llm.ts` | | |
| `SessionPrompt.shell` | | |
| `SessionPrompt.node` | | |
| `system.ts` `environment()` | | |

Any **Keep** row with a caller → do **not** delete that symbol. Cut the caller to `SessionV2` first (stop and report if the V2 API is missing the capability — do not stub).

- [ ] **Step 2: Only then delete empty rows**

If `runLoop` has zero `src/` callers: remove that function and migrate `test/session/prompt.test.ts` onto `SessionV2.prompt`.

If `applyCaching` still runs under `session/llm.ts` and that LLM service is still provided: **leave it**. Removing it would change title/native/copy streams. Track it as “second compile still alive on non-prompt streams” in spec Risks; do not rip it to make Wave D look done.

- [ ] **Step 3: Proof no feature regress**

```bash
bun --cwd packages/opencode test test/session/prompt.test.ts test/provider/transform.test.ts test/session/llm-native.test.ts
bun --cwd packages/core test test/session-runner.test.ts
```

All must PASS. A red test means migrate or revert, not “delete the test because V1.”

```bash
rg -n "SessionPrompt\\.prompt\\(|runLoop" packages/opencode/src
```

- [ ] **Step 4: Commit only what Step 1 allowed**

```bash
git add -p
git commit -m "$(cat <<'EOF'
fix(opencode): drop unused SessionPrompt runLoop after caller inventory

Do not delete still-live V1-named modules. Tape remains only on
SessionRunner. Suffix rename is a later PR.
EOF
)"
```

---

## Self-review

| Spec requirement | Task |
|---|---|
| Next body = previous body + tail | 1, 3, 4, 6, 8 |
| Cancel re-lowering (`compiled`) | 3 |
| System written once | 6, 7 |
| Volatile = user tail (verifier/recall/context update) | 7 |
| Exact streamed tool arguments | 5, 8 |
| No system-update merge | 1 (negative), 3, 5, 7 |
| Last-step keeps tools | 9 |
| §3.6 every cache-moving path (coverage matrix, not four rows) | 9b |
| Persist tape | 10 |
| Prewarm system-only | 11 |
| Compaction = new tape | 12 |
| Allowlist | 2 |
| Live Layer A `read > 0` on 5k | 12 |
| Live Layer B 99.85% on ~100k | 12, 13 |
| Identical generation envelope on scored pair | 12 |
| One compile; unused duplicate removed only after inventory; no blanket V1 delete | 14 |
| No arg canonicalize / no dummy user / no offline 99.85 CI | global constraints |

`toLLMMessages` remains for UI-adjacent tests and **hydrate of a new tape only**. If Task 6 still hydrates on empty-tape resume, Task 8 must stop calling it on the hot path.

Reference: Hermes `_cached_system_prompt` + user-tail recall → Tasks 6–7; Codex prefix-identity + prewarm → Tasks 1, 8, 11; Chat has no `previous_response_id` → the tape **is** the local equivalent (Tasks 4, 10).
