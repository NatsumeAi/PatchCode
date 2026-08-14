# Prompt Cache Hit Rate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make prefix-cache hits measurable and non-regressed, then raise steady-state input hit toward 99.85% on the production Go/Zen path.

**Architecture:** CI locks *compiled prefix bytes* (hash + overlap) so a functional-green change cannot silently shrink the cacheable prefix. Live usage is scored only on OpenCode Go DeepSeek V4 Flash and OpenCode Zen. Behavior changes (tool freeze, dynamic system out of prefix, breakpoint policy) land only after a characterization baseline, and only if overlap / live hit do not fall.

**Tech Stack:** TypeScript, Effect, Bun test, `LLMClient.prepare` / `LLMClient.generate`, OpenAI-compatible Chat (`cached_tokens`).

**Spec:** `docs/superpowers/specs/2026-08-14-prompt-cache-hit-design.md`

**Repo root:** `/home/huyongjun/openpartner/opencode`

---

## Live model allowlist (hard rule)

This workstream **must not** call any model outside this table. No Anthropic, OpenAI, Gemini, Bedrock, OpenRouter, `api.deepseek.com`, or ad-hoc `opencode.json` providers — not even “just to compare.”

| Role | Config id | Provider | Model | Base URL | Protocol |
|---|---|---|---|---|---|
| **Primary, required** | `opencode-go/deepseek-v4-flash` | `opencode-go` | `deepseek-v4-flash` | `https://opencode.ai/zen/go/v1` | OpenAI-compatible Chat `/chat/completions` |
| **Secondary, allowed** | `opencode/deepseek-v4-flash` | `opencode` | `deepseek-v4-flash` | `https://opencode.ai/zen/v1` | same Chat path |
| **Secondary, allowed** | `opencode/deepseek-v4-flash-free` | `opencode` | `deepseek-v4-flash-free` | `https://opencode.ai/zen/v1` | same Chat path |

`OPENCODE_ZEN_CACHE_MODEL` may be `deepseek-v4-flash` (default) or `deepseek-v4-flash-free`. Any other value throws. Do not fall through to another vendor. Expanding this set later is an explicit allowlist edit, not an env pointing at Anthropic/OpenAI/Gemini.

Auth (never commit):

- `OPENCODE_API_KEY` (shared), or
- `OPENCODE_GO_API_KEY` for Go, `OPENCODE_ZEN_API_KEY` for Zen

Live tests **skip** unless `LIVE_CACHE=1` (or `RECORD=true`) **and** a key is present. Default `bun test` CI stays offline.

Existing Anthropic/OpenAI/Gemini *replay* cassettes in the repo are left alone. This plan **does not add** new recordings or live cases for those providers.

---

## File map

| File | Responsibility |
|---|---|
| `packages/llm/src/cache-prefix.ts` | Canonical JSON + sha256 + overlap over a prepared wire body |
| `packages/llm/test/cache-prefix.test.ts` | Offline unit tests for hash/overlap |
| `packages/llm/test/live/allowlist.ts` | The only place live models are constructed |
| `packages/llm/test/live/go-deepseek-cache.live.test.ts` | Go DeepSeek identical-call + tool-loop usage |
| `packages/llm/test/live/zen-cache.live.test.ts` | Same scenarios on Zen |
| `packages/core/test/session/runner/cache-prefix-contract.test.ts` | Runner-shaped system/tools/messages stay stable across two prepares |
| `packages/llm/src/cache-policy.ts` | Later: last-message breakpoint + optional 1h TTL (offline-proven) |
| `packages/core/src/tool/registry.ts` | Later: sort + epoch-stable task catalog |
| `packages/core/src/session/runner/llm.ts` | Later: verifier/timer out of `system[]` |
| `packages/core/src/session/runner/publish-llm-event.ts` | Later: attach hit-rate on `Step.Ended` tokens |

---

## Task 1: Prefix hash / overlap (offline, no models)

**Files:**
- Create: `packages/llm/src/cache-prefix.ts`
- Test: `packages/llm/test/cache-prefix.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { commonPrefixLength, overlapRatio, stableHash, stableStringify } from "../src/cache-prefix"

describe("cache-prefix", () => {
  test("stableStringify sorts object keys", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }))
  })

  test("hash changes when a prefix byte changes", () => {
    const a = { tools: [{ name: "read" }], system: "S", messages: [{ role: "user", content: "hi" }] }
    const b = { tools: [{ name: "write" }], system: "S", messages: [{ role: "user", content: "hi" }] }
    expect(stableHash(a)).not.toBe(stableHash(b))
  })

  test("overlap is 1 when body B is A plus a trailing message", () => {
    const a = {
      tools: [{ name: "t1" }],
      system: [{ text: "sys" }],
      messages: [{ role: "user", content: "u1" }],
    }
    const b = {
      tools: [{ name: "t1" }],
      system: [{ text: "sys" }],
      messages: [
        { role: "user", content: "u1" },
        { role: "assistant", content: "ok" },
        { role: "tool", content: "result" },
      ],
    }
    expect(overlapRatio(a, b)).toBeGreaterThan(0.4)
    expect(commonPrefixLength(a, b)).toBeGreaterThan(0)
  })

  test("overlap drops when system prefix changes", () => {
    const a = { tools: [], system: [{ text: "A" }], messages: [{ role: "user", content: "u" }] }
    const b = { tools: [], system: [{ text: "B" }], messages: [{ role: "user", content: "u" }] }
    expect(overlapRatio(a, b)).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/huyongjun/openpartner/opencode
bun test packages/llm/test/cache-prefix.test.ts
```

Expected: FAIL — `cache-prefix` module not found.

- [ ] **Step 3: Implement `packages/llm/src/cache-prefix.ts`**

```ts
import { createHash } from "node:crypto"

export const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>()
  const walk = (item: unknown): unknown => {
    if (item === null || typeof item !== "object") return item
    if (seen.has(item)) return "[cycle]"
    seen.add(item)
    if (Array.isArray(item)) return item.map(walk)
    const record = item as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) out[key] = walk(record[key])
    return out
  }
  return JSON.stringify(walk(value))
}

export const stableHash = (value: unknown): string =>
  createHash("sha256").update(stableStringify(value)).digest("hex")

export type WirePrefix = {
  readonly tools?: unknown
  readonly system?: unknown
  readonly messages?: unknown
}

const prefixParts = (body: WirePrefix): unknown[] => [body.tools ?? [], body.system ?? [], body.messages ?? []]

export const commonPrefixLength = (left: WirePrefix, right: WirePrefix): number => {
  const a = stableStringify(prefixParts(left))
  const b = stableStringify(prefixParts(right))
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

export const overlapRatio = (previous: WirePrefix, next: WirePrefix): number => {
  const nextLen = stableStringify(prefixParts(next)).length
  if (nextLen === 0) return 1
  return commonPrefixLength(previous, next) / nextLen
}

export const hitRate = (cacheRead: number, uncachedInput: number): number => {
  const read = Math.max(0, cacheRead)
  const fresh = Math.max(0, uncachedInput)
  const denom = read + fresh
  return denom === 0 ? 0 : read / denom
}
```

Re-export from `packages/llm/src/index.ts` only if other packages need it; tests may import the file path directly to keep the public API small.

- [ ] **Step 4: Re-run tests — expect PASS**

```bash
bun test packages/llm/test/cache-prefix.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/llm/src/cache-prefix.ts packages/llm/test/cache-prefix.test.ts packages/llm/src/index.ts
git commit -m "$(cat <<'EOF'
test(llm): add deterministic prompt-prefix hash and overlap

Offline gate for cache-hit work: compiled body bytes can be compared
across turns without calling a provider.
EOF
)"
```

---

## Task 2: Live allowlist helper

**Files:**
- Create: `packages/llm/test/live/allowlist.ts`
- Test: `packages/llm/test/live/allowlist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test"
import { assertLiveModel, GO_FLASH, ZEN_DEFAULT, resolveZenModel } from "./allowlist"

describe("live cache allowlist", () => {
  test("go flash is the only go model", () => {
    expect(GO_FLASH).toEqual({
      providerID: "opencode-go",
      modelID: "deepseek-v4-flash",
      baseURL: "https://opencode.ai/zen/go/v1",
    })
  })

  test("zen default is deepseek-v4-flash on the zen host", () => {
    expect(ZEN_DEFAULT.baseURL).toBe("https://opencode.ai/zen/v1")
    expect(ZEN_DEFAULT.providerID).toBe("opencode")
    expect(ZEN_DEFAULT.modelID).toBe("deepseek-v4-flash")
  })

  test("rejects non-zen model ids", () => {
    expect(() => resolveZenModel("gpt-4o")).toThrow(/allowlist/i)
    expect(() => resolveZenModel("claude-sonnet-4-5")).toThrow(/allowlist/i)
    expect(() => assertLiveModel({ providerID: "anthropic", modelID: "x" })).toThrow(/allowlist/i)
    expect(() => assertLiveModel({ providerID: "opencode-go", modelID: "glm-5.2" })).toThrow(/allowlist/i)
  })
})
```

Go is locked to **only** `deepseek-v4-flash`. Zen may use other **Zen catalog** ids (allow the documented zen list, not vendor ids). Put the zen id set in `allowlist.ts` from `packages/web/src/content/docs/zen.mdx` (DeepSeek V4 Flash / Flash Free plus other zen rows). Do **not** accept `gpt-4o` as a raw OpenAI id even if Zen also has a GPT SKU — live helper must use the Zen id (`gpt-5`, `claude-sonnet-4-5` as `opencode/claude-sonnet-4-5` only). Simplest safe default for this plan: Zen live tests use `deepseek-v4-flash` or `deepseek-v4-flash-free` only, unless `OPENCODE_ZEN_CACHE_MODEL` is one of those two. User said “zen 也可以”; do not expand the default runner to paid Claude/GPT. Document that a human may point `OPENCODE_ZEN_CACHE_MODEL` at another **zen** id later, but the checked-in live tests stay on DeepSeek Flash / Flash Free.

Locked checked-in live models:

- `opencode-go/deepseek-v4-flash`
- `opencode/deepseek-v4-flash`
- `opencode/deepseek-v4-flash-free`

- [ ] **Step 2: Run — expect FAIL** (module missing)

```bash
bun test packages/llm/test/live/allowlist.test.ts
```

- [ ] **Step 3: Implement `packages/llm/test/live/allowlist.ts`**

```ts
import { OpenAICompatible } from "../../src/providers/openai-compatible"
import type { Model } from "../../src"

export const GO_FLASH = {
  providerID: "opencode-go",
  modelID: "deepseek-v4-flash",
  baseURL: "https://opencode.ai/zen/go/v1",
} as const

export const ZEN_DEFAULT = {
  providerID: "opencode",
  modelID: "deepseek-v4-flash",
  baseURL: "https://opencode.ai/zen/v1",
} as const

const ZEN_LIVE_IDS = new Set(["deepseek-v4-flash", "deepseek-v4-flash-free"])

export const resolveZenModel = (modelID: string) => {
  if (!ZEN_LIVE_IDS.has(modelID)) {
    throw new Error(`live cache allowlist: zen model "${modelID}" is not permitted`)
  }
  return { ...ZEN_DEFAULT, modelID }
}

export const assertLiveModel = (input: { providerID: string; modelID: string }) => {
  if (input.providerID === GO_FLASH.providerID && input.modelID === GO_FLASH.modelID) return
  if (input.providerID === "opencode" && ZEN_LIVE_IDS.has(input.modelID)) return
  throw new Error(`live cache allowlist: ${input.providerID}/${input.modelID} is not permitted`)
}

export const liveEnabled = () => process.env.LIVE_CACHE === "1" || process.env.RECORD === "true"

export const goApiKey = () => process.env.OPENCODE_GO_API_KEY ?? process.env.OPENCODE_API_KEY

export const zenApiKey = () => process.env.OPENCODE_ZEN_API_KEY ?? process.env.OPENCODE_API_KEY

export const goModel = (): Model => {
  const apiKey = goApiKey()
  if (!apiKey) throw new Error("OPENCODE_API_KEY or OPENCODE_GO_API_KEY required")
  assertLiveModel(GO_FLASH)
  return OpenAICompatible.configure({
    provider: GO_FLASH.providerID,
    baseURL: GO_FLASH.baseURL,
    apiKey,
  }).model(GO_FLASH.modelID)
}

export const zenModel = (): Model => {
  const apiKey = zenApiKey()
  if (!apiKey) throw new Error("OPENCODE_API_KEY or OPENCODE_ZEN_API_KEY required")
  const spec = resolveZenModel(process.env.OPENCODE_ZEN_CACHE_MODEL ?? ZEN_DEFAULT.modelID)
  assertLiveModel(spec)
  return OpenAICompatible.configure({
    provider: spec.providerID,
    baseURL: spec.baseURL,
    apiKey,
  }).model(spec.modelID)
}
```

- [ ] **Step 4: Re-run allowlist tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/llm/test/live/allowlist.ts packages/llm/test/live/allowlist.test.ts
git commit -m "$(cat <<'EOF'
test(llm): lock live cache tests to Go/Zen DeepSeek flash

No other provider or model may be constructed for live cache scoring.
EOF
)"
```

---

## Task 3: Characterization — current compiled prefix (offline)

**Files:**
- Create: `packages/llm/test/cache-prefix-characterization.test.ts`

Purpose: snapshot **today’s** `auto` policy + a runner-shaped request so later diffs are visible. Do not change product code.

- [ ] **Step 1: Write a prepare-based snapshot test** using `OpenAICompatible.configure({ provider: "opencode-go", baseURL: "https://opencode.ai/zen/go/v1", apiKey: "fixture" }).model("deepseek-v4-flash")` — fixture key, **no network**. Build:

```ts
const request = LLM.request({
  model,
  system: ["agent system", "baseline env", "persona"],
  messages: [
    Message.user("do the task"),
    Message.assistant("calling read"),
    Message.tool({ id: "c1", name: "read", result: { type: "text", value: "file body" } }),
  ],
  tools: [
    { name: "read", description: "read", inputSchema: { type: "object", properties: {} } },
    { name: "bash", description: "bash", inputSchema: { type: "object", properties: {} } },
  ],
})
const prepared = yield* LLMClient.prepare(request)
```

Assert and snapshot:

- `prepared.route === "openai-compatible-chat"`
- `prepared.body.model === "deepseek-v4-flash"`
- `stableHash({ tools: prepared.body.tools, system: prepared.body.messages?.filter(...) })` written as an explicit expected hex **after the first run** (replace `PLACEHOLDER` once you have the hash)
- document current overlap between “turn 1 = user only” and “turn 2 = user+asst+tool” using `overlapRatio`

First commit may use `console.log(stableHash(...))` then pin the hex. Do not call the network.

- [ ] **Step 2: Run**

```bash
bun test packages/llm/test/cache-prefix-characterization.test.ts
```

- [ ] **Step 3: Pin hashes, commit**

```bash
git add packages/llm/test/cache-prefix-characterization.test.ts
git commit -m "$(cat <<'EOF'
test(llm): characterize current Go-shaped compiled prefix

Baseline overlap/hashes so later cache work cannot silently shrink the prefix.
EOF
)"
```

---

## Task 4: Runner contract — system/tools must not churn (offline)

**Files:**
- Create: `packages/core/test/session/runner/cache-prefix-contract.test.ts`
- Modify later: `packages/core/src/tool/registry.ts`, `packages/core/src/session/runner/llm.ts`

This task **only tests current behavior**. If today’s runner fails “system hash equal when verifier feedback appears”, **do not fix yet** — record it as `test.skip` with a comment `// G4 baseline: verifier in system[]` and a dedicated `test("documents G4: verifier changes last system part")` that **asserts the current (bad) fact**. That way Task 8’s fix flips the skip into a real invariant.

- [ ] **Step 1: Extract two prepared bodies from runner-equivalent inputs**

Use `toLLMMessages` + a fake `LLM.request` the same way `session-runner.test.ts` already builds requests. Two prepares:

1. no verifier feedback
2. with verifier feedback string

Current expected (document): `stableHash(system1) !== stableHash(system2)` — this is G4.

Two tool materializations in a row with the same agent: current expected `stableHash(tools1) === stableHash(tools2)` **if** the registry map is insertion-stable in tests; add a third case that registers tools in reverse order if the test harness can. If order is already stable in a single process, add an explicit `toSorted` assertion in Task 7 and keep this task as “same agent twice → same tools hash”.

- [ ] **Step 2: Run**

```bash
bun test packages/core/test/session/runner/cache-prefix-contract.test.ts
```

- [ ] **Step 3: Commit the documentation tests**

```bash
git commit -m "$(cat <<'EOF'
test(core): document current prefix-churn contracts for cache work
EOF
)"
```

---

## Task 5: Live Go DeepSeek — identical second call

**Files:**
- Create: `packages/llm/test/live/go-deepseek-cache.live.test.ts`

- [ ] **Step 1: Write the test (skip when not armed)**

```ts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM } from "../../src"
import { LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { LARGE_CACHEABLE_SYSTEM } from "../recorded-scenarios"
import { GO_FLASH, goApiKey, goModel, liveEnabled } from "./allowlist"

const armed = liveEnabled() && Boolean(goApiKey())

describe.skipIf(!armed)("live Go deepseek-v4-flash cache", () => {
  it.effect("second identical generate reports cache_read > 0", () =>
    Effect.gen(function* () {
      const request = LLM.request({
        id: "live_go_flash_identical",
        model: goModel(),
        system: LARGE_CACHEABLE_SYSTEM,
        prompt: "Reply with the single word pong.",
        generation: { maxTokens: 16, temperature: 0 },
      })
      const first = yield* LLMClient.generate(request)
      const second = yield* LLMClient.generate(request)
      const read = second.usage?.cacheReadInputTokens ?? 0
      const uncached = second.usage?.nonCachedInputTokens ?? 0
      // Probe: if both are 0, the host is not reporting cached_tokens — fail loudly.
      expect(read + uncached).toBeGreaterThan(0)
      expect(read).toBeGreaterThan(0)
    }),
  )
})
```

If the first armed run shows `cacheReadInputTokens` always undefined, **stop and record the finding in the spec** (“Go Chat usage omits `cached_tokens`”). Do not invent hits. Keep the test as `expect(second.usage).toBeDefined()` and a logged dump of `providerMetadata` so a human can see the raw usage. Do **not** switch to another vendor to “get a number.”

- [ ] **Step 2: Offline run (no env) — tests skip, suite still green**

```bash
bun test packages/llm/test/live/go-deepseek-cache.live.test.ts
```

Expected: skipped or 0 tests run, exit 0.

- [ ] **Step 3: Armed run**

```bash
cd /home/huyongjun/openpartner/opencode
LIVE_CACHE=1 bun test packages/llm/test/live/go-deepseek-cache.live.test.ts
```

Use the already-configured OpenCode Go key in the environment. Do not paste keys into files.

Expected: PASS if the host reports prefix cache; otherwise follow the probe fallback above.

- [ ] **Step 4: Commit**

```bash
git add packages/llm/test/live/go-deepseek-cache.live.test.ts
git commit -m "$(cat <<'EOF'
test(llm): live Go DeepSeek v4 flash identical-prefix cache probe

Gated by LIVE_CACHE=1. No other models.
EOF
)"
```

---

## Task 6: Live Go DeepSeek — growing tool-loop prefix

**Files:**
- Modify: `packages/llm/test/live/go-deepseek-cache.live.test.ts`

- [ ] **Step 1: Add a second live case**

Sequence (same `promptCacheKey` / same system / same tools):

1. user only → generate (warmup write)
2. append assistant + tool_result (fixed strings, not model-dependent) → generate
3. append another assistant + tool_result → generate

Assert on request 3:

- `cacheReadInputTokens > cacheRead` of request 2 (prefix grew and hit), **or**
- `hitRate(read, uncached) > hitRate` of request 2

If the model ignores our fake tool_result replay, do **not** drive a real multi-tool agent loop against a second vendor. Stay on `LLMClient.generate` with explicitly constructed messages (we are scoring **prefix cache**, not tool-calling quality).

Keep `system` ≥ `LARGE_CACHEABLE_SYSTEM` so the implicit cache threshold is cleared.

- [ ] **Step 2: Armed run**

```bash
LIVE_CACHE=1 bun test packages/llm/test/live/go-deepseek-cache.live.test.ts
```

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
test(llm): live Go DeepSeek tool-loop prefix growth cache reads
EOF
)"
```

---

## Task 7: Live Zen DeepSeek flash (same two scenarios)

**Files:**
- Create: `packages/llm/test/live/zen-cache.live.test.ts`

Copy Task 5–6 but `zenModel()` / `zenApiKey()`. Default model `opencode/deepseek-v4-flash`. `OPENCODE_ZEN_CACHE_MODEL=deepseek-v4-flash-free` is the only other checked-in value.

```bash
LIVE_CACHE=1 bun test packages/llm/test/live/zen-cache.live.test.ts
```

Skip if no Zen key. Do not fall back to Go inside this file.

- [ ] **Commit**

```bash
git commit -m "$(cat <<'EOF'
test(llm): live Zen DeepSeek flash cache probe

Allowlisted zen host only; default deepseek-v4-flash.
EOF
)"
```

---

## Task 8: Fix G4 — verifier / timer out of frozen system (after baseline exists)

**Files:**
- Modify: `packages/core/src/session/runner/llm.ts` (the `system: [agent, baseline, persona, verifierFeedback]` array around the `LLM.request` call)
- Modify: `packages/core/test/session/runner/cache-prefix-contract.test.ts`

- [ ] **Step 1: Flip the Task 4 documentation test**

New expected: two prepares that differ only by verifier feedback have **identical** `hash(system)` and `hash(tools)`. Feedback is a trailing `Message.user` or `Message.system` **after** the transcript, not a `SystemPart`.

- [ ] **Step 2: Run — FAIL on current llm.ts**

- [ ] **Step 3: Minimal change**

```ts
const system = [agent.info?.system, system.baseline, personaSystem]
  .filter((part): part is string => part !== undefined && part.length > 0)
  .map(SystemPart.make)
const feedbackMessage = verifierFeedback
  ? [Message.user(verifierFeedback)]
  : []
const request = LLM.request({
  model,
  providerOptions: { openai: { promptCacheKey } },
  system,
  messages: [...toLLMMessages(context, model), ...feedbackMessage, ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
  tools: toolMaterialization?.definitions ?? [],
  toolChoice: isLastStep ? "none" : undefined,
})
```

Do not put the clock or verifier into `system.baseline`.

- [ ] **Step 4: Offline tests + characterization overlap must be ≥ pinned baseline**

```bash
bun test packages/core/test/session/runner/cache-prefix-contract.test.ts packages/llm/test/cache-prefix-characterization.test.ts
```

If characterization hashes change, update them in the same commit **only after** confirming `overlapRatio` on the growing-loop fixture did not drop.

- [ ] **Step 5: Armed live regression**

```bash
LIVE_CACHE=1 bun test packages/llm/test/live/go-deepseek-cache.live.test.ts
```

If live hit on request 3 falls vs the number recorded in Task 6’s commit message / comment, revert this task.

- [ ] **Step 6: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(core): keep verifier/timer out of the cached system prefix

Dynamic harness text is appended as a trailing message so Go/Zen
implicit prefix cache can hit tools+system+history.
EOF
)"
```

---

## Task 9: Fix G3 — stable tool definitions

**Files:**
- Modify: `packages/core/src/tool/registry.ts` `materialize` (the `Array.from(registrations, …)` line)
- Test: `packages/core/test/session/runner/cache-prefix-contract.test.ts` or `packages/core/test/tool-registry-capability.test.ts`

- [ ] **Step 1: Failing test** — two materializations whose `Map` insertion order differs (register `bash` then `read` vs `read` then `bash`) must produce the same `definitions.map(d => d.name)` and the same `stableHash(definitions)`.

- [ ] **Step 2: Implement** — `Array.from(registrations).toSorted(([a], [b]) => a.localeCompare(b))` before `definition()`. Freeze the `task` description appendix for the epoch: compute `describeTaskAgents` once per `SessionContextEpoch` generation (store on the epoch row **or** compute once in `runTurnAttempt` and reuse). Do not re-read a live agent catalog into the tool description mid-epoch.

If storing on the epoch row is too large for this pass: compute appendix once in `runTurnAttempt` and pass the frozen definitions through the drain. Do not call `describeTaskAgents` on every later step if the catalog can change.

- [ ] **Step 3: Offline tests + live Go flash (Task 6) must not regress**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(core): sort and epoch-freeze advertised tool definitions

Tool JSON is the first prefix segment for implicit cache; shuffle
or a live task-catalog rewrite busts the entire hit.
EOF
)"
```

---

## Task 10: Offline cache-policy last-message breakpoint (no live Anthropic)

**Files:**
- Modify: `packages/llm/src/cache-policy.ts` (`AUTO.messages`)
- Modify: `packages/llm/test/cache-policy.test.ts`

DeepSeek/Go/Zen **ignore** inline `cache_control`. This task still lands because Anthropic/Bedrock compile through the same policy, and we must not leave latest-user as the only strategy. **Verification is `LLMClient.prepare` only. Do not add Anthropic live tests.**

- [ ] **Step 1: Change AUTO to mark the last message (not only latest user)**

```ts
const AUTO: CachePolicyObject = {
  tools: true,
  system: true,
  messages: "latest-assistant", // last content-bearing message is better; if the last role is tool, mark that part
  ttlSeconds: 3600,
}
```

If `latest-assistant` misses a trailing tool-result-only message, extend `markMessages` with `"latest-message"` (new literal) and use that. Update `CachePolicyObject` in `packages/llm/src/schema/options.ts` accordingly. Prefer one new literal over overloading `"latest-assistant"`.

- [ ] **Step 2: Update `cache-policy.test.ts`** — Anthropic prepared body: last tool_result / last message has `cache_control`, first user does **not** (unless it is the only message). `ttl: "1h"` on markers.

- [ ] **Step 3: Run**

```bash
bun test packages/llm/test/cache-policy.test.ts packages/llm/test/cache-prefix-characterization.test.ts
```

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
fix(llm): cache auto-policy marks the last message with 1h TTL

Offline Anthropic/Bedrock wire only. Live scoring stays on Go/Zen.
EOF
)"
```

---

## Task 11: Persist steady-state hit on Step.Ended

**Files:**
- Modify: `packages/core/src/session/runner/publish-llm-event.ts` (where `tokens` is built from usage)
- Optional log line in `runTurnAttempt` after usage is known

```ts
const read = safe(usage?.cacheReadInputTokens)
const write = safe(usage?.cacheWriteInputTokens)
const input = safe(usage?.nonCachedInputTokens)
const hit = input + read === 0 ? 0 : read / (input + read)
```

Do not treat `write` as a hit. Do not fail the turn if hit is low. Log:

`cache_hit steady=0.xxxx read=N uncached=M write=W model=opencode-go/deepseek-v4-flash`

- [ ] **Step 1: Unit-test `hitRate` already in Task 1; add a publish-llm-event test if one exists, else assert via session-runner token fields**

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(core): log steady-state input cache hit from provider usage
EOF
)"
```

---

## Task 12: Final gate

- [ ] Offline:

```bash
cd /home/huyongjun/openpartner/opencode
bun test packages/llm/test/cache-prefix.test.ts \
  packages/llm/test/live/allowlist.test.ts \
  packages/llm/test/cache-prefix-characterization.test.ts \
  packages/llm/test/cache-policy.test.ts \
  packages/core/test/session/runner/cache-prefix-contract.test.ts
```

Expected: all PASS.

- [ ] Live (human/agent with keys, this machine is allowed):

```bash
LIVE_CACHE=1 bun test packages/llm/test/live/go-deepseek-cache.live.test.ts
LIVE_CACHE=1 bun test packages/llm/test/live/zen-cache.live.test.ts
```

Expected: PASS, or skip Zen if only a Go key exists. **Go flash is required** before claiming the live gate is done.

- [ ] Confirm `git grep` on the new live tests: no `api.anthropic.com`, `api.openai.com`, `generativelanguage`, `api.deepseek.com`, `ANTHROPIC_API_KEY` as a live require.

- [ ] Update the spec “Risks” section with the actual Go `cached_tokens` probe result (reports / does not report).

- [ ] Commit docs-only if the spec gained probe notes.

---

## Self-review

| Spec requirement | Task |
|---|---|
| Metric A, exclude first-write/compact/switch | Task 1 `hitRate` + Task 11 log + spec |
| CI prefix hash/overlap | Tasks 1, 3, 4 |
| Negative / no silent drop | Tasks 3, 4, 8, 9 (overlap ≥ baseline) |
| Live Go DeepSeek v4 flash only + Zen allowed | Tasks 2, 5, 6, 7, 12 |
| No other live models | Task 2 helper throws; Task 12 grep |
| G4 verifier out of system | Task 8 |
| G3 tool freeze | Task 9 |
| G1 last-message breakpoint | Task 10 (offline only) |
| 1h TTL | Task 10 |
| Measurement before behavior change | Tasks 1–7 before 8–10 |

No TBD/TODO placeholders. Live keys stay in env.
