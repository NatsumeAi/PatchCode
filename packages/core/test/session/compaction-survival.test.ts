import { describe, expect, test } from "bun:test"
import { LLMEvent, Model } from "@opencode-ai/llm"
import { OpenAIChat } from "@opencode-ai/llm/protocols/openai-chat"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { Effect, Stream } from "effect"
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

const model = Model.make({
  id: "test-model",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 100_000, output: 4_096 } }),
})

const bigEntries = [
  user(1, "x".repeat(9000)),
  assistant(2, "y".repeat(9000)),
  user(3, "z".repeat(9000)),
  assistant(4, "w".repeat(9000)),
  user(5, "v".repeat(9000)),
]

const makeHarness = (outputs: string[]) => {
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
  const compaction = SessionCompaction.make({ events, llm, config: [] })
  return { compaction, published }
}

const runCompact = (compaction: ReturnType<typeof SessionCompaction.make>, entries: readonly Entry[]) =>
  Effect.gen(function* () {
    return yield* compaction.compactAfterOverflow({
      sessionID: "ses_test" as SessionSchema.ID,
      entries,
      model,
      request: { model, messages: [] } as never,
    })
  }).pipe(Effect.runPromise)

const compactionMessage = (survival: Record<string, number>): Entry => ({
  seq: 99,
  message: SessionMessage.Compaction.make({
    id: "msg_99" as SessionMessage.ID,
    type: "compaction",
    reason: "auto",
    summary: "earlier summary",
    ...(Object.keys(survival).length === 0 ? {} : { survival }),
    time: { created: DateTime.makeUnsafe(TS + 99) },
  }),
})

import { DateTime } from "effect"

describe("SessionCompaction survival persistence", () => {
  test("first compaction records survival for selected and recent items", async () => {
    const { compaction, published } = makeHarness(["<selection>[1]</selection>\nsummary one"])
    const ok = await runCompact(compaction, bigEntries)
    expect(ok).toBe(true)
    const ended = published.find((p) => p.type === "session.next.compaction.ended")
    expect(ended).toBeDefined()
    const survival = ended!.data.survival as Record<string, number>
    // item 1 (first head turn) was selected → count 1
    expect(survival["msg_1"]).toBe(1)
    // recent turns (turn2 user3 + turn3 user5) get count 1
    expect(survival["msg_3"]).toBe(1)
    expect(survival["msg_5"]).toBe(1)
  })

  test("second compaction increments survival for items that survive", async () => {
    // round 1: select item 1 → survival {msg_1: 1, msg_5: 1}
    const { compaction, published } = makeHarness([
      "<selection>[1]</selection>\nsummary one",
      "<selection>[1]</selection>\nsummary two",
    ])
    const first = await runCompact(compaction, bigEntries)
    expect(first).toBe(true)
    const firstEnded = published.find((p) => p.type === "session.next.compaction.ended")
    const firstSurvival = firstEnded!.data.survival as Record<string, number>

    // round 2: entries = big entries + previous compaction message; select item 1 again
    const secondEntries = [...bigEntries, compactionMessage(firstSurvival)]
    const second = await runCompact(compaction, secondEntries)
    expect(second).toBe(true)
    const secondEnded = published.findLast((p) => p.type === "session.next.compaction.ended")
    const secondSurvival = secondEnded!.data.survival as Record<string, number>
    // item 1 was selected in both rounds → 2
    expect(secondSurvival["msg_1"]).toBe(2)
    // recent turns are re-counted from the new round
    expect(secondSurvival["msg_5"]).toBeGreaterThanOrEqual(1)
  })

  test("degraded path still records recent-item survival", async () => {
    const { compaction, published } = makeHarness([
      "<selection>[1,99]</selection>\nbad",
      "<selection>[1,98]</selection>\nbad",
      "degraded summary",
    ])
    const ok = await runCompact(compaction, bigEntries)
    expect(ok).toBe(true)
    const ended = published.find((p) => p.type === "session.next.compaction.ended")
    const survival = ended!.data.survival as Record<string, number>
    // no selected items survive the degrade, but recent turns still count
    expect(survival["msg_1"]).toBeUndefined()
    expect(survival["msg_5"]).toBe(1)
  })
})
