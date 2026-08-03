import { describe, expect, test } from "bun:test"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { Token } from "@opencode-ai/core/util/token"

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

const system = (n: number, text: string): Entry => ({
  seq: n,
  message: { id: `msg_${n}`, type: "system", text, time: { created: TS + n } } as unknown as SessionMessage.System,
})

const synthetic = (n: number, text: string): Entry => ({
  seq: n,
  message: {
    id: `msg_${n}`,
    type: "synthetic",
    sessionID: "ses_test",
    text,
    time: { created: TS + n },
  } as unknown as SessionMessage.Synthetic,
})

const toolCallAssistant = (n: number, toolID: string, input: string): Entry => ({
  seq: n,
  message: {
    id: `msg_${n}`,
    type: "assistant",
    agent: "build",
    model: { id: "test-model", providerID: "test", variant: "default" },
    content: [
      {
        type: "tool",
        id: toolID,
        name: "bash",
        time: { created: TS + n },
        state: {
          status: "completed",
          input: { command: input },
          structured: {},
          content: [{ type: "text", text: `result of ${input}` }],
        },
      },
    ],
    time: { created: TS + n },
  } as unknown as SessionMessage.Assistant,
})

const compactionEntry = (): Entry => ({
  seq: 5,
  message: {
    id: "msg_5",
    type: "compaction",
    reason: "auto",
    summary: "previous summary",
    time: { created: TS + 5 },
  } as unknown as SessionMessage.Compaction,
})

const entriesOf = (...entries: Entry[]) => entries

describe("SessionCompaction.selectTurns", () => {
  test("splits turns at user boundaries; leading non-user messages form their own turn", () => {
    const entries = entriesOf(system(1, "baseline"), user(2, "first"), assistant(3, "reply 1"), user(4, "second"), assistant(5, "reply 2"))
    const { head, recent, items } = SessionCompaction.selectTurns(entries, 10_000, 10_000)
    expect(recent.length).toBe(3)
    expect(head.length).toBe(0)
    expect(items.length).toBe(0)
    expect(recent[0]!.entries[0]!.message.type).toBe("system")
    expect(recent[1]!.entries[0]!.message.type).toBe("user")
    expect(recent[1]!.entries[1]!.message.type).toBe("assistant")
    expect(recent[2]!.entries[0]!.message.type).toBe("user")
  })

  test("recent cut lands on a turn boundary, never mid-turn", () => {
    const entries = entriesOf(user(1, "a"), assistant(2, "b"), user(3, "c"), assistant(4, "d"))
    const secondTurnTokens = Token.estimate(`[User]: c`) + Token.estimate(`[Assistant]: d`)
    const { head, recent } = SessionCompaction.selectTurns(entries, secondTurnTokens, 10_000)
    expect(head.length).toBe(1)
    expect(recent.length).toBe(1)
    expect(head[0]!.entries.map((e) => e.seq)).toEqual([1, 2])
    expect(recent[0]!.entries.map((e) => e.seq)).toEqual([3, 4])
  })

  test("a turn larger than the recent budget goes entirely to head", () => {
    const entries = entriesOf(user(1, "x".repeat(4000)), assistant(2, "y".repeat(4000)))
    const { head, recent } = SessionCompaction.selectTurns(entries, 100, 10_000)
    expect(head.length).toBe(1)
    expect(recent.length).toBe(0)
    expect(head[0]!.entries.map((e) => e.seq)).toEqual([1, 2])
  })

  test("toolCall+toolResult stay in one group: the assistant message is never split", () => {
    const entries = entriesOf(user(1, "run it"), toolCallAssistant(2, "tool-1", "echo hi"), user(3, "next"))
    const { head, recent } = SessionCompaction.selectTurns(entries, Token.estimate(`[User]: next`), 10_000)
    expect(recent.map((t) => t.entries[0]!.seq)).toEqual([3])
    expect(head.length).toBe(1)
    // the tool assistant message joins the preceding user turn and is never split
    const toolTurn = head[0]!
    expect(toolTurn.entries.map((e) => e.seq)).toEqual([1, 2])
    const content = toolTurn.entries[1]!.message
    expect(content.type).toBe("assistant")
    if (content.type === "assistant") {
      expect(content.content.some((part) => part.type === "tool")).toBe(true)
    }
  })

  test("items number only the head turns; labels are 1-based in order", () => {
    const entries = entriesOf(user(1, "one"), assistant(2, "a"), user(3, "two"), assistant(4, "b"))
    const secondTurnTokens = Token.estimate(`[User]: two`) + Token.estimate(`[Assistant]: b`)
    const { items } = SessionCompaction.selectTurns(entries, secondTurnTokens, 10_000)
    expect(items.length).toBe(1)
    expect(items[0]!.label).toBe("1")
    expect(items[0]!.kind).toBe("turn")
    expect(items[0]!.key).toBe("msg_1")
    expect(items[0]!.tokens).toBeGreaterThan(0)
    expect(items[0]!.survival).toBe(0)
  })

  test("synthetic messages start new turns like user messages", () => {
    const entries = entriesOf(synthetic(1, "synthetic note"), assistant(2, "reply"), user(3, "real"))
    const { head, recent, items } = SessionCompaction.selectTurns(entries, Token.estimate(`[User]: real`), 10_000)
    expect(recent.length).toBe(1)
    expect(head.length).toBe(1)
    expect(head[0]!.entries[0]!.message.type).toBe("synthetic")
    // synthetic starts its own turn; the following assistant joins it
    expect(head[0]!.entries.map((e) => e.seq)).toEqual([1, 2])
    expect(items.length).toBe(1)
  })

  test("oversized turns split into subturns each under 2/3 of the selection limit", () => {
    const selectionLimit = 1200
    const entries = entriesOf(user(1, "x".repeat(8000)), assistant(2, "y".repeat(1000)))
    const { items } = SessionCompaction.selectTurns(entries, 50, selectionLimit)
    expect(items.length).toBeGreaterThan(1)
    for (const item of items) {
      expect(item.label.startsWith("1")).toBe(true)
      if (item.entries.length > 1 || item.entries[0]!.seq !== 1) expect(item.tokens).toBeLessThan((selectionLimit * 2) / 3)
    }
    expect(items[0]!.label).toBe("1a")
    expect(items[1]!.label).toBe("1b")
    expect(items.every((item) => item.key.length > 0)).toBe(true)
  })

  test("small turns do not split into subturns", () => {
    const entries = entriesOf(user(1, "small"), assistant(2, "also small"))
    const firstTurnTokens = Token.estimate(`[User]: small`) + Token.estimate(`[Assistant]: also small`)
    const { items } = SessionCompaction.selectTurns(entries, firstTurnTokens - 1, 10_000)
    expect(items.length).toBe(1)
    expect(items[0]!.kind).toBe("turn")
    expect(items[0]!.label).toBe("1")
  })

  test("compaction messages are excluded from turns entirely", () => {
    const entries = entriesOf(user(1, "one"), compactionEntry(), user(6, "two"))
    const { head, recent } = SessionCompaction.selectTurns(entries, 10_000, 10_000)
    const allSeqs = [...head, ...recent].flatMap((turn) => turn.entries.map((e) => e.seq))
    expect(allSeqs).not.toContain(5)
  })
})

describe("SessionCompaction.formatNumberedItems", () => {
  test("renders label, percentage, and survival tag", () => {
    const items = [
      {
        key: "msg_1",
        kind: "turn" as const,
        label: "1",
        tokens: 2000,
        survival: 0,
        entries: [user(1, "hello world")],
      },
      {
        key: "msg_2",
        kind: "subturn" as const,
        label: "2a",
        tokens: 1000,
        survival: 0,
        entries: [assistant(2, "reply")],
      },
    ]
    const rendered = SessionCompaction.formatNumberedItems(items, 100_000, { msg_1: 3, msg_2: 1 })
    expect(rendered).toContain("[1] (2.0%) ×3 [User]: hello world")
    expect(rendered).toContain("[2a] (1.0%) ×1 [Assistant]: reply")
  })

  test("omits the survival tag when the item has no survival count", () => {
    const items = [{ key: "msg_1", kind: "turn" as const, label: "1", tokens: 500, survival: 0, entries: [user(1, "hi")] }]
    const rendered = SessionCompaction.formatNumberedItems(items, 10_000)
    expect(rendered).toBe("[1] (5.0%) [User]: hi")
  })

  test("returns empty string for no items", () => {
    expect(SessionCompaction.formatNumberedItems([], 10_000)).toBe("")
  })
})
