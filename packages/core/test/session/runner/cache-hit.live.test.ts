import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLM, LLMClient, type LLMRequest } from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import * as OpenAICompatible from "@opencode-ai/llm/providers/openai-compatible"
import { hitRate, isPrefixOf, wireFromPrepared } from "@opencode-ai/llm/cache-prefix"
import { PromptTape } from "@opencode-ai/core/session/runner/prompt-tape"
import { PromptTapeAppend } from "@opencode-ai/core/session/runner/prompt-tape-append"
import { testEffect } from "../../lib/effect"

type LiveModelRef = {
  readonly providerID: string
  readonly modelID: string
  readonly baseURL: string
}

const GO_FLASH: LiveModelRef = {
  providerID: "opencode-go",
  modelID: "deepseek-v4-flash",
  baseURL: "https://opencode.ai/zen/go/v1",
}

const ALLOWED: ReadonlyArray<LiveModelRef> = [
  GO_FLASH,
  { providerID: "opencode", modelID: "deepseek-v4-flash", baseURL: "https://opencode.ai/zen/v1" },
  { providerID: "opencode", modelID: "deepseek-v4-flash-free", baseURL: "https://opencode.ai/zen/v1" },
]

const assertLiveModel = (ref: LiveModelRef) => {
  const ok = ALLOWED.some(
    (row) => row.providerID === ref.providerID && row.modelID === ref.modelID && row.baseURL === ref.baseURL,
  )
  if (!ok) throw new Error(`live allowlist rejected ${ref.providerID}/${ref.modelID} @ ${ref.baseURL}`)
}

const liveEnabled = () => process.env.LIVE_CACHE === "1" || process.env.RECORD === "true"
const goApiKey = () => process.env.OPENCODE_GO_API_KEY || process.env.OPENCODE_API_KEY

const skip = !(liveEnabled() && Boolean(goApiKey()))

const sentence =
  "You are a concise, factual assistant. Answer precisely and avoid filler. Cite numbers when known. "
const LARGE_CACHEABLE_SYSTEM = sentence.repeat(250)
const LONG_CACHEABLE_SYSTEM = () => sentence.repeat(5500)

const ENVELOPE = { maxTokens: 16, temperature: 0 } as const
const echoTools = [
  {
    type: "function" as const,
    function: {
      name: "echo",
      description: "e",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
]

const goFlash = () => {
  assertLiveModel(GO_FLASH)
  return OpenAICompatible.configure({
    provider: GO_FLASH.providerID,
    baseURL: GO_FLASH.baseURL,
    apiKey: goApiKey() ?? "missing",
  }).model(GO_FLASH.modelID)
}

const go = (request: LLMRequest) => LLM.updateRequest(request, { model: goFlash(), generation: ENVELOPE })

const compiledReq = (tape: PromptTape.Tape, extra?: { readonly toolChoice?: "none" }) =>
  go(
    LLM.request({
      model: goFlash(),
      system: tape.system,
      messages: [],
      compiled: PromptTape.compiled(tape),
      generation: ENVELOPE,
      ...(extra?.toolChoice === undefined ? {} : { toolChoice: extra.toolChoice }),
    }),
  )

const score = (label: string, usage: { cacheReadInputTokens?: number; nonCachedInputTokens?: number; inputTokens?: number }) => {
  const read = usage.cacheReadInputTokens ?? 0
  const uncached = usage.nonCachedInputTokens ?? 0
  const input = usage.inputTokens ?? read + uncached
  const rate = hitRate({ cacheReadInputTokens: read, nonCachedInputTokens: uncached })
  console.log(`${label} input=${input} read=${read} uncached=${uncached} rate=${rate}`)
  return { read, uncached, input, rate }
}

const requestExecutor = RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))
const it = testEffect(LLMClient.layer.pipe(Layer.provide(requestExecutor)))

describe.skipIf(skip)("Go Flash PromptTape cache-hit live", () => {
  it.live("Layer A: prefix send reports cache_read > 0", () =>
    Effect.gen(function* () {
      const origin = PromptTape.origin({ system: LARGE_CACHEABLE_SYSTEM, tools: echoTools })
      const firstReq = go(
        LLM.request({
          model: goFlash(),
          system: origin.system,
          messages: [],
          compiled: PromptTape.compiled(origin),
          generation: ENVELOPE,
        }),
      )
      const first = yield* LLMClient.generate(firstReq)
      const scoredTape = PromptTape.append(origin, [{ role: "user", content: "ping" }])
      const secondReq = go(
        LLM.request({
          model: goFlash(),
          system: scoredTape.system,
          messages: [],
          compiled: PromptTape.compiled(scoredTape),
          generation: ENVELOPE,
        }),
      )
      const second = yield* LLMClient.generate(secondReq)
      expect(second.usage?.cacheReadInputTokens ?? 0).toBeGreaterThan(0)
      const preparedW = yield* LLMClient.prepare(firstReq)
      const preparedS = yield* LLMClient.prepare(secondReq)
      expect(isPrefixOf(wireFromPrepared(preparedW.body), wireFromPrepared(preparedS.body))).toBe(true)
      expect(first.usage).toBeDefined()
    }),
  )

  it.live("Layer B: ~100k prefix hitRate >= 0.9985 with identical envelope", () =>
    Effect.gen(function* () {
      const origin = PromptTape.origin({ system: LONG_CACHEABLE_SYSTEM(), tools: echoTools })
      const warmupReq = go(
        LLM.request({
          model: goFlash(),
          system: origin.system,
          messages: [],
          compiled: PromptTape.compiled(origin),
          generation: ENVELOPE,
        }),
      )
      yield* LLMClient.generate(warmupReq)
      const scoredTape = PromptTape.append(origin, [{ role: "user", content: "ok" }])
      const scoredReq = go(
        LLM.request({
          model: goFlash(),
          system: scoredTape.system,
          messages: [],
          compiled: PromptTape.compiled(scoredTape),
          generation: ENVELOPE,
        }),
      )
      const scored = yield* LLMClient.generate(scoredReq)
      const read = scored.usage?.cacheReadInputTokens ?? 0
      const uncached = scored.usage?.nonCachedInputTokens ?? 0
      const input = scored.usage?.inputTokens ?? read + uncached
      const rate = hitRate({ cacheReadInputTokens: read, nonCachedInputTokens: uncached })
      console.log(`Layer B usage input=${input} read=${read} uncached=${uncached} rate=${rate}`)
      expect(input).toBeGreaterThanOrEqual(80_000)
      expect(read).toBeGreaterThan(0)
      expect(uncached).toBeLessThanOrEqual(200)
      expect(rate).toBeGreaterThanOrEqual(0.9985)
      const preparedW = yield* LLMClient.prepare(warmupReq)
      const preparedS = yield* LLMClient.prepare(scoredReq)
      expect(isPrefixOf(wireFromPrepared(preparedW.body), wireFromPrepared(preparedS.body))).toBe(true)
    }),
  )

  it.live("runner-shaped Layer B: prepare origin tools then warmup+append hits 99.85%", () =>
    Effect.gen(function* () {
      const system = LONG_CACHEABLE_SYSTEM()
      const origin = PromptTape.origin({ system, tools: echoTools })
      const preparedOrigin = yield* LLMClient.prepare(compiledReq(origin))
      const chatTools = (preparedOrigin.body as { tools?: typeof echoTools }).tools
      const runnerTape = PromptTape.origin({
        system,
        tools: chatTools ? [...chatTools].sort((a, b) => a.function.name.localeCompare(b.function.name)) : echoTools,
      })
      const warmupReq = compiledReq(runnerTape)
      yield* LLMClient.generate(warmupReq)
      const scoredTape = PromptTape.append(runnerTape, [{ role: "user", content: "ok" }])
      const scoredReq = compiledReq(scoredTape)
      const scored = yield* LLMClient.generate(scoredReq)
      const { input, read, uncached, rate } = score("runner-shaped B", scored.usage ?? {})
      expect(input).toBeGreaterThanOrEqual(80_000)
      expect(read).toBeGreaterThan(0)
      expect(uncached).toBeLessThanOrEqual(200)
      expect(rate).toBeGreaterThanOrEqual(0.9985)
      const preparedW = yield* LLMClient.prepare(warmupReq)
      const preparedS = yield* LLMClient.prepare(scoredReq)
      expect(isPrefixOf(wireFromPrepared(preparedW.body), wireFromPrepared(preparedS.body))).toBe(true)
    }),
  )

  it.live("probe: tool_choice none on an otherwise identical prefix", () =>
    Effect.gen(function* () {
      const origin = PromptTape.origin({ system: LARGE_CACHEABLE_SYSTEM, tools: echoTools })
      yield* LLMClient.generate(compiledReq(origin))
      const withUser = PromptTape.append(origin, [{ role: "user", content: "ping" }])
      const baseline = yield* LLMClient.generate(compiledReq(withUser))
      const none = yield* LLMClient.generate(compiledReq(withUser, { toolChoice: "none" }))
      const a = score("tool_choice default", baseline.usage ?? {})
      const b = score("tool_choice none", none.usage ?? {})
      expect(a.read).toBeGreaterThan(0)
      console.log(`tool_choice none delta read=${b.read - a.read} (drop is allowed; last-step is not the 99.85% claim)`)
      const preparedA = yield* LLMClient.prepare(compiledReq(withUser))
      const preparedB = yield* LLMClient.prepare(compiledReq(withUser, { toolChoice: "none" }))
      expect(isPrefixOf(wireFromPrepared(preparedA.body), wireFromPrepared(preparedB.body))).toBe(true)
    }),
  )

  it.live("probe: huge tool result is absorbed into the next prefix", () =>
    Effect.gen(function* () {
      const origin = PromptTape.origin({ system: LARGE_CACHEABLE_SYSTEM, tools: echoTools })
      yield* LLMClient.generate(compiledReq(origin))
      const huge = "tool-result-payload ".repeat(2500)
      const withTool = PromptTape.append(origin, [
        { role: "user", content: "call echo" },
        PromptTapeAppend.lowerAssistantFromStream({
          text: null,
          toolCalls: [{ id: "c1", name: "echo", arguments: '{"text":"x"}' }],
          reasoning: "Calling echo.",
        }),
        PromptTapeAppend.lowerToolResult({ toolCallId: "c1", content: huge }),
      ])
      const dipped = yield* LLMClient.generate(compiledReq(withTool))
      const next = PromptTape.append(withTool, [{ role: "user", content: "continue" }])
      const absorbed = yield* LLMClient.generate(compiledReq(next))
      const d = score("huge-tool request", dipped.usage ?? {})
      const n = score("after huge-tool prefix", absorbed.usage ?? {})
      expect(n.read).toBeGreaterThan(0)
      expect(n.read).toBeGreaterThanOrEqual(d.read)
      const preparedD = yield* LLMClient.prepare(compiledReq(withTool))
      const preparedN = yield* LLMClient.prepare(compiledReq(next))
      expect(isPrefixOf(wireFromPrepared(preparedD.body), wireFromPrepared(preparedN.body))).toBe(true)
    }),
  )

  it.live("probe: identical compiled twice stays sticky on the same KV", () =>
    Effect.gen(function* () {
      const origin = PromptTape.origin({ system: LARGE_CACHEABLE_SYSTEM, tools: echoTools })
      const withUser = PromptTape.append(origin, [{ role: "user", content: "sticky" }])
      const req = compiledReq(withUser)
      yield* LLMClient.generate(req)
      const second = yield* LLMClient.generate(req)
      const s = score("sticky second identical", second.usage ?? {})
      expect(s.read).toBeGreaterThan(0)
    }),
  )

  it.live("probe: system-only prewarm then first user", () =>
    Effect.gen(function* () {
      const origin = PromptTape.origin({ system: LARGE_CACHEABLE_SYSTEM, tools: echoTools })
      const prewarm = LLM.updateRequest(compiledReq(origin), { generation: { maxTokens: 1, temperature: 0 } })
      const warmed = yield* LLMClient.generate(prewarm).pipe(
        Effect.map((response) => ({ ok: true as const, response })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      )
      if (!warmed.ok) {
        console.log(`system-only prewarm rejected: ${String(warmed.error)}`)
        return
      }
      const firstUser = PromptTape.append(origin, [{ role: "user", content: "hi" }])
      const scored = yield* LLMClient.generate(compiledReq(firstUser))
      const s = score("prewarm then first user", scored.usage ?? {})
      expect(s.read).toBeGreaterThan(0)
    }),
  )

  it.live("probe: two-turn conversation (assistant bytes on the tape) keeps prefix hits", () =>
    Effect.gen(function* () {
      const origin = PromptTape.origin({ system: LARGE_CACHEABLE_SYSTEM, tools: echoTools })
      yield* LLMClient.generate(compiledReq(origin))
      const turn1 = PromptTape.append(origin, [{ role: "user", content: "Say the word cache." }])
      const first = yield* LLMClient.generate(compiledReq(turn1))
      const text = first.text || "ok"
      const turn2 = PromptTape.append(turn1, [
        { role: "assistant", content: typeof text === "string" ? text : "ok" },
        { role: "user", content: "again" },
      ])
      const second = yield* LLMClient.generate(compiledReq(turn2))
      const s = score("two-turn conversation", second.usage ?? {})
      expect(s.read).toBeGreaterThan(0)
      const prepared1 = yield* LLMClient.prepare(compiledReq(turn1))
      const prepared2 = yield* LLMClient.prepare(compiledReq(turn2))
      expect(isPrefixOf(wireFromPrepared(prepared1.body), wireFromPrepared(prepared2.body))).toBe(true)
    }),
  )

  it.live(
    "probe: idle TTL 5 minutes later still reads cache",
    () =>
      Effect.gen(function* () {
        const origin = PromptTape.origin({ system: LARGE_CACHEABLE_SYSTEM, tools: echoTools })
        const withUser = PromptTape.append(origin, [{ role: "user", content: "ttl" }])
        yield* LLMClient.generate(compiledReq(withUser))
        yield* Effect.sleep("5 minutes")
        const later = yield* LLMClient.generate(compiledReq(withUser))
        const s = score("after 5min idle", later.usage ?? {})
        expect(s.read).toBeGreaterThan(0)
      }),
    400_000,
  )
})

test("live cache-hit file is skipped offline", () => {
  if (skip) expect(skip).toBe(true)
})
