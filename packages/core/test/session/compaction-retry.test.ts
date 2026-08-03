import { describe, expect, test } from "bun:test"
import { LLMEvent, Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { Effect, Stream } from "effect"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionSchema } from "@opencode-ai/core/session/schema"

type Entry = { readonly seq: number; readonly message: SessionMessage.Message }

const TS = 1_700_000_000_000

const user = (n: number, text: string): Entry => ({
  seq: n,
  message: { id: `msg_${n}`, type: "user", text, time: { created: TS + n } } as unknown as SessionMessage.User,
})

const assistant = (n: number, text: string): Entry => ({
  seq: n,
  message: {
    id: `msg_${n}`,
    type: "assistant",
    agent: "build",
    model: { id: "test-model", providerID: "test", variant: "default" },
    content: text.length === 0 ? [] : [{ type: "text", id: `t-msg_${n}`, text }],
    time: { created: TS + n },
  } as unknown as SessionMessage.Assistant,
})

// model with a 100k context window → recent budget 10k, selection limit 10k
const model = Model.make({
  id: "test-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 100_000, output: 4_096 } }),
})

const entries = [
  user(1, "x".repeat(9000)),
  assistant(2, "y".repeat(9000)),
  user(3, "z".repeat(9000)),
  assistant(4, "w".repeat(9000)),
  user(5, "v".repeat(9000)),
]

const makeEvents = () => {
  const published: { type: string; data: Record<string, unknown> }[] = []
  const events = {
    publish: (definition: { type: string }, data: Record<string, unknown>) =>
      Effect.sync(() => {
        published.push({ type: definition.type, data })
        return { durable: { aggregateID: "ses_test", seq: published.length, version: 1 } }
      }),
  } as never
  return { events, published }
}

const makeLlm = (outputs: Array<string | { error: true }>) => {
  let calls = 0
  return {
    stream: () => {
      const index = Math.min(calls, outputs.length - 1)
      calls += 1
      const output = outputs[index]
      if (output === undefined) return Stream.empty
      if (typeof output === "object" && "error" in output) {
        return Stream.succeed(LLMEvent.providerError({ message: "boom" }))
      }
      return Stream.succeed(LLMEvent.textDelta({ id: "blk_1", text: output }))
    },
    callCount: () => calls,
  }
}

const run = (
  llmOutputs: Array<string | { error: true }>,
) =>
  Effect.gen(function* () {
    const { events, published } = makeEvents()
    const llm = makeLlm(llmOutputs)
    const compaction = SessionCompaction.make({ events, llm, config: [] })
    const ok = yield* compaction.compactAfterOverflow({
      sessionID: "ses_test" as SessionSchema.ID,
      entries,
      model,
      request: { model, messages: [] } as never,
    })
    return { ok, published, calls: llm.callCount() }
  }).pipe(Effect.runPromise)

describe("SessionCompaction.compactAfterOverflow correction loop", () => {
  test("happy path: one call, valid selection, events published", async () => {
    const { ok, published, calls } = await run(["<selection>[1]</selection>\nsummary of everything"])
    expect(ok).toBe(true)
    expect(calls).toBe(1)
    expect(published.some((p) => p.type === "session.next.compaction.started")).toBe(true)
    const ended = published.find((p) => p.type === "session.next.compaction.ended")
    expect(ended).toBeDefined()
    expect(String(ended!.data.text)).toContain("summary of everything")
    // Task 6: the Ended event no longer carries a recent field
    expect("recent" in ended!.data).toBe(false)
  })

  test("accepts a selection within 1.5x of the limit", async () => {
    // selection limit 10k; item 1+2 tokens tiny → always within; emulate over-limit by selecting everything
    const { ok } = await run(["<selection>[1,2,3,4,5]</selection>\nsummary"])
    expect(ok).toBe(true)
  })

  test("over-budget selection triggers one reselect, then accepts", async () => {
    // Force an over-budget by returning a selection that references all items;
    // validation cannot be over-budget with tiny tokens, so emulate with a
    // huge-limit scenario instead: this test asserts the correction loop runs
    // once when validation rejects (unknown number), then succeeds.
    const { ok, calls, published } = await run([
      "<selection>[1,99]</selection>\nsummary v1",
      "<selection>[1]</selection>\nsummary v2",
    ])
    expect(ok).toBe(true)
    expect(calls).toBe(2)
    const ended = published.find((p) => p.type === "session.next.compaction.ended")
    // D15: the summary is cached from the first attempt and never redone
    expect(String(ended!.data.text)).toContain("summary v1")
  })

  test("two bad selections degrade to the Pi-style full summary", async () => {
    const { ok, calls, published } = await run([
      "<selection>[1,99]</selection>\nbad1",
      "<selection>[2,98]</selection>\nbad2",
      "degraded full summary",
    ])
    expect(ok).toBe(true)
    expect(calls).toBe(3)
    const ended = published.find((p) => p.type === "session.next.compaction.ended")
    expect(String(ended!.data.text)).toContain("degraded full summary")
  })

  test("summary failure retries once, then succeeds", async () => {
    const { ok, calls } = await run([{ error: true }, "<selection>[1]</selection>\nretried summary"])
    expect(ok).toBe(true)
    expect(calls).toBe(2)
  })

  test("two summary failures degrade to the Pi fallback", async () => {
    const { ok, calls } = await run([{ error: true }, { error: true }, "fallback summary"])
    expect(ok).toBe(true)
    expect(calls).toBe(3)
  })

  test("total failures return false without events", async () => {
    const { ok, calls, published } = await run([{ error: true }, { error: true }, { error: true }, { error: true }])
    expect(ok).toBe(false)
    expect(calls).toBeLessThanOrEqual(4)
    expect(published.some((p) => p.type === "session.next.compaction.ended")).toBe(false)
  })
})

test("greedy truncation packs largest-first after repeated over-budget selections", async () => {
  // limit = 10% of 100k = 10000; make items heavy so any selection is over 1.5x
  const bigEntries2 = [
    user(1, "a".repeat(39000)), // ~9.75k tokens each — over-budget together, packable singly
    user(2, "b".repeat(39000)),
    user(3, "c".repeat(39000)),
    user(4, "d".repeat(1000)), // small recent
  ]
  const harness = () => {
    const published: { type: string; data: Record<string, unknown> }[] = []
    let calls = 0
    const events = {
      publish: (definition: { type: string }, data: Record<string, unknown>) =>
        Effect.sync(() => {
          published.push({ type: definition.type, data })
          return { durable: { aggregateID: "ses_test", seq: published.length, version: 1 } }
        }),
    } as never
    const llm = {
      stream: () => {
        // both selection attempts select everything (over budget); summary text stable
        const out = calls < 2 ? "<selection>[1a,2a,3a]</selection>\nstable summary" : undefined
        calls += 1
        if (out === undefined) return Stream.empty
        return Stream.succeed(LLMEvent.textDelta({ id: "blk_1", text: out }))
      },
    }
    const compaction = SessionCompaction.make({ events, llm, config: [] })
    return { compaction, published, callCount: () => calls }
  }
  const { compaction, published, callCount } = harness()
  const ok = await Effect.gen(function* () {
    return yield* compaction.compactAfterOverflow({
      sessionID: "ses_test" as SessionSchema.ID,
      entries: bigEntries2,
      model,
      request: { model, messages: [] } as never,
    })
  }).pipe(Effect.runPromise)
  expect(ok).toBe(true)
  // 2 selection attempts (both over 1.5x) → greedy pack, no degrade call
  expect(callCount()).toBe(2)
  const ended = published.find((p) => p.type === "session.next.compaction.ended")
  const kept = ended!.data.kept as string[]
  // D9: pack largest-first — the largest subturn that fits is kept
  expect(kept).toContain("msg_1")
})

test("zero selection is a valid outcome keeping only the recent region", async () => {
  const bigEntries3 = [
    user(1, "a".repeat(50000)),
    user(2, "b".repeat(50000)),
    user(3, "c".repeat(1000)), // recent
  ]
  const published: { type: string; data: Record<string, unknown> }[] = []
  const events = {
    publish: (definition: { type: string }, data: Record<string, unknown>) =>
      Effect.sync(() => {
        published.push({ type: definition.type, data })
        return { durable: { aggregateID: "ses_test", seq: published.length, version: 1 } }
      }),
  } as never
  let calls = 0
  const llm = {
    stream: () => {
      calls += 1
      // the model decides nothing is worth keeping verbatim
      return Stream.succeed(LLMEvent.textDelta({ id: "blk_1", text: "<selection>[]</selection>\npure summary" }))
    },
  }
  const compaction = SessionCompaction.make({ events, llm, config: [] })
  const ok = await Effect.gen(function* () {
    return yield* compaction.compactAfterOverflow({
      sessionID: "ses_test" as SessionSchema.ID,
      entries: bigEntries3,
      model,
      request: { model, messages: [] } as never,
    })
  }).pipe(Effect.runPromise)
  expect(ok).toBe(true)
  expect(calls).toBe(1)
  const ended = published.find((p) => p.type === "session.next.compaction.ended")
  expect(String(ended!.data.text)).toContain("pure summary")
  // kept = recent region only (msg_3); head items are not kept
  const kept = ended!.data.kept as string[]
  expect(kept).toEqual(["msg_3"])
})

test("correction rounds use the selection-only prompt without re-summarizing", async () => {
  const bigEntries4 = [
    user(1, "x".repeat(50000)),
    user(2, "y".repeat(50000)),
    user(3, "z".repeat(1000)),
  ]
  const requests: { system: string; maxTokens?: number }[] = []
  const published: { type: string; data: Record<string, unknown> }[] = []
  const events = {
    publish: (definition: { type: string }, data: Record<string, unknown>) =>
      Effect.sync(() => {
        published.push({ type: definition.type, data })
        return { durable: { aggregateID: "ses_test", seq: published.length, version: 1 } }
      }),
  } as never
  let calls = 0
  const llm = {
    stream: (request: { system?: { text?: string }[]; generation?: { maxTokens?: number } }) => {
      calls += 1
      requests.push({
        system: (request.system?.[0]?.text ?? "").slice(0, 60),
        maxTokens: request.generation?.maxTokens,
      })
      const out =
        calls === 1
          ? "<selection>[1a,99]</selection>\nfirst summary text"
          : "<selection>[1a]</selection>\nignored second summary"
      return Stream.succeed(LLMEvent.textDelta({ id: "blk_1", text: out }))
    },
  }
  const compaction = SessionCompaction.make({ events, llm, config: [] })
  const ok = await Effect.gen(function* () {
    return yield* compaction.compactAfterOverflow({
      sessionID: "ses_test" as SessionSchema.ID,
      entries: bigEntries4,
      model,
      request: { model, messages: [] } as never,
    })
  }).pipe(Effect.runPromise)
  expect(ok).toBe(true)
  expect(requests).toHaveLength(2)
  // first round: full summarization system prompt; correction round: selection-only
  expect(requests[0]!.system).toContain("context summarizer")
  expect(requests[1]!.system).toContain("previously selected items")
  // correction round gets a small token budget (selection list only)
  expect(requests[1]!.maxTokens).toBeLessThanOrEqual(256)
  const ended = published.find((p) => p.type === "session.next.compaction.ended")
  // cached first-round summary is persisted, not the correction round's text
  expect(String(ended!.data.text)).toContain("first summary text")
})
