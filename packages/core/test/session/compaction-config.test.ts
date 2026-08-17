import { describe, expect, test } from "bun:test"
import { LLMEvent, Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Effect, Stream } from "effect"
import { SessionSchema } from "@opencode-ai/core/session/schema"

type Entry = { readonly seq: number; readonly message: SessionMessage.Message }

const TS = 1_700_000_000_000

const user = (n: number, text: string): Entry => ({
  seq: n,
  message: { id: `msg_${n}`, type: "user", text, time: { created: TS + n } } as unknown as SessionMessage.User,
})

const model = Model.make({
  id: "test-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 100_000, output: 4_096 } }),
})

const bigEntries = [user(1, "x".repeat(50000)), user(2, "y".repeat(50000)), user(3, "z".repeat(1000))]

const makeHarness = (outputs: string[], config: readonly Config.Entry[]) => {
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
      const output = outputs[Math.min(calls, outputs.length - 1)]
      calls += 1
      if (output === undefined) return Stream.empty
      return Stream.succeed(LLMEvent.textDelta({ id: "blk_1", text: output }))
    },
  }
  const compaction = SessionCompaction.make({ events, llm, config })
  return {
    compaction,
    published,
    callCount: () => calls,
  }
}

const run = (compaction: ReturnType<typeof SessionCompaction.make>) =>
  Effect.gen(function* () {
    return yield* compaction.compactAfterOverflow({
      sessionID: "ses_test" as SessionSchema.ID,
      entries: bigEntries,
      model,
      request: { model, messages: [] } as never,
    })
  }).pipe(Effect.runPromise)

const defaultConfig: readonly Config.Entry[] = []

type ConfigOverrides = {
  select?: { enabled?: boolean; budget?: number; retry?: number }
  summary?: { l?: number; k?: number }
  keep?: { tokens?: number; recent?: number }
}

const configWith = (overrides: ConfigOverrides) =>
  [
    new Config.Document({
      type: "document",
      info: new Config.Info({
        compaction: new ConfigCompaction.Info({
          ...overrides,
          ...(overrides.select === undefined ? {} : { select: new ConfigCompaction.Select(overrides.select) }),
          ...(overrides.summary === undefined ? {} : { summary: new ConfigCompaction.Summary(overrides.summary) }),
          ...(overrides.keep === undefined ? {} : { keep: new ConfigCompaction.Keep(overrides.keep) }),
        }),
      }),
    }),
  ] satisfies readonly Config.Entry[]

describe("SessionCompaction configuration (Task 10)", () => {
  test("select disabled skips the selection call and degrades directly", async () => {
    const { compaction, callCount, published } = makeHarness(["degraded full summary"], configWith({ select: { enabled: false } }))
    const ok = await run(compaction)
    expect(ok).toBe(true)
    // one degrade call only, no selection attempt
    expect(callCount()).toBe(1)
    const ended = published.find((p) => p.type === "session.next.compaction.ended")
    expect(String(ended!.data.text)).toContain("degraded full summary")
  })

  test("select.retry=0 gives one attempt then degrades", async () => {
    const { compaction, callCount } = makeHarness(
      ["<selection>[1,99]</selection>\nbad", "degraded summary"],
      configWith({ select: { retry: 0 } }),
    )
    const ok = await run(compaction)
    expect(ok).toBe(true)
    // one selection attempt (invalid) + one degrade call
    expect(callCount()).toBe(2)
  })

  test("select.retry=2 allows two corrections before degrading", async () => {
    const { compaction, callCount } = makeHarness(
      ["<selection>[1,99]</selection>\nbad1", "<selection>[2,98]</selection>\nbad2", "<selection>[3,97]</selection>\nbad3", "degraded"],
      configWith({ select: { retry: 2 } }),
    )
    const ok = await run(compaction)
    expect(ok).toBe(true)
    // 3 selection attempts (invalid) + 1 degrade
    expect(callCount()).toBe(4)
  })

  test("default settings apply when config is empty", async () => {
    const { compaction, callCount, published } = makeHarness(["<selection>[1a]</selection>\nok summary"], defaultConfig)
    const ok = await run(compaction)
    expect(ok).toBe(true)
    expect(callCount()).toBe(1)
    const ended = published.find((p) => p.type === "session.next.compaction.ended")
    expect(ended!.data.keptFrom).toBeDefined()
  })

  test("toPluginMessages uses official {info, parts} shape", () => {
    const messages = SessionCompaction.toPluginMessages([user(1, "hello")])
    expect(messages[0]?.info.role).toBe("user")
    expect(messages[0]?.parts[0]).toMatchObject({ type: "text", text: "hello" })
  })
})
