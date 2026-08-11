import { describe, expect, test } from "bun:test"
import { LLMEvent, Model, type LLMRequest } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Effect, Stream } from "effect"
import { SessionSchema } from "@opencode-ai/core/session/schema"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

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

const promptTextOf = (request: LLMRequest) =>
  request.messages[0]?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? ""

const makeHarness = (
  outputs: string[],
  config: readonly Config.Entry[],
  onPreCompress?: (entries: readonly Entry[], sessionID: SessionSchema.ID) => Effect.Effect<string>,
) => {
  const published: { type: string; data: Record<string, unknown> }[] = []
  const prompts: string[] = []
  let calls = 0
  const events = {
    publish: (definition: { type: string }, data: Record<string, unknown>) =>
      Effect.sync(() => {
        published.push({ type: definition.type, data })
        return { durable: { aggregateID: "ses_test", seq: published.length, version: 1 } }
      }),
  } as never
  const llm = {
    stream: (request: LLMRequest) => {
      prompts.push(promptTextOf(request))
      const output = outputs[Math.min(calls, outputs.length - 1)]
      calls += 1
      if (output === undefined) return Stream.empty
      return Stream.succeed(LLMEvent.textDelta({ id: "blk_1", text: output }))
    },
  }
  const compaction = SessionCompaction.make({ events, llm, config, onPreCompress })
  return { compaction, published, prompts, callCount: () => calls }
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

const INSIGHTS = "- [path] packages/core/src/session/compaction.ts\n- [decision] use deterministic extraction"

describe("SessionCompaction pre-compress insights", () => {
  test("insights from onPreCompress are injected into the summarize prompt", async () => {
    const received: { entries: readonly Entry[]; sessionID: SessionSchema.ID }[] = []
    const { compaction, published, prompts } = makeHarness(
      ["<selection>[1a]</selection>\nok summary"],
      [],
      (entries, sessionID) =>
        Effect.sync(() => {
          received.push({ entries, sessionID })
          return INSIGHTS
        }),
    )
    const ok = await run(compaction)
    expect(ok).toBe(true)
    expect(prompts[0]).toContain("## Memory insights to preserve")
    expect(prompts[0]).toContain(INSIGHTS)
    expect(received[0].sessionID).toBe("ses_test" as SessionSchema.ID)
    expect(received[0].entries).toHaveLength(3)
    const ended = published.find((p) => p.type === "session.next.compaction.ended")
    expect(String(ended!.data.text)).toContain("ok summary")
  })

  test("insights that push the summarize request over the window are dropped, not fatal", async () => {
    const hugeInsights = "x".repeat(400_000)
    const { compaction, published, prompts } = makeHarness(
      ["<selection>[1a]</selection>\nok summary"],
      [],
      () => Effect.succeed(hugeInsights),
    )
    const ok = await run(compaction)
    expect(ok).toBe(true)
    expect(prompts[0]).not.toContain("## Memory insights to preserve")
    expect(prompts[0]).not.toContain(hugeInsights)
    const ended = published.find((p) => p.type === "session.next.compaction.ended")
    expect(String(ended!.data.text)).toContain("ok summary")
  })

  test("insights also feed the degraded summarize prompt", async () => {
    const config = [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          compaction: new ConfigCompaction.Info({ select: new ConfigCompaction.Select({ enabled: false }) }),
        }),
      }),
    ]
    const { compaction, prompts } = makeHarness(["degraded summary"], config, () => Effect.succeed(INSIGHTS))
    const ok = await run(compaction)
    expect(ok).toBe(true)
    expect(prompts[0]).toContain("## Memory insights to preserve")
    expect(prompts[0]).toContain(INSIGHTS)
  })
})
