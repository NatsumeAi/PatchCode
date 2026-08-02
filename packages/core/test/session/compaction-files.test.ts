import { describe, expect, test } from "bun:test"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

const TS = 1_700_000_000_000

const toolMessage = (name: string, pathValue: string): SessionMessage.Message =>
  ({
    id: `msg_${name}_${pathValue.replace(/\W/g, "")}`,
    type: "assistant",
    agent: "build",
    model: { id: "test-model", providerID: "test", variant: "default" },
    content: [
      {
        type: "tool",
        id: `tool-${name}`,
        name,
        time: { created: TS },
        state: {
          status: "completed",
          input: { path: pathValue },
          structured: {},
          content: [],
        },
      },
    ],
    time: { created: TS },
  }) as unknown as SessionMessage.Assistant

const user = (text: string): SessionMessage.Message =>
  ({ id: `msg_u${text}`, type: "user", text, time: { created: TS } }) as unknown as SessionMessage.User

describe("SessionCompaction.extractFileOps", () => {
  test("extracts read/write/edit paths from completed tool calls", () => {
    const messages = [
      toolMessage("read", "src/a.ts"),
      toolMessage("read", "src/b.ts"),
      toolMessage("write", "src/new.ts"),
      toolMessage("edit", "src/a.ts"),
    ]
    const ops = SessionCompaction.extractFileOps(messages)
    expect(ops.read).toEqual(["src/b.ts"])
    expect(ops.modified).toEqual(["src/a.ts", "src/new.ts"])
  })

  test("a written file is never listed as read (Pi semantics)", () => {
    const messages = [toolMessage("read", "same.ts"), toolMessage("write", "same.ts")]
    const ops = SessionCompaction.extractFileOps(messages)
    expect(ops.read).toEqual([])
    expect(ops.modified).toEqual(["same.ts"])
  })

  test("inherits and merges the previous compaction's file list, deduplicated", () => {
    const previous = { read: ["src/a.ts", "legacy.ts"], modified: ["src/b.ts"] }
    const messages = [toolMessage("read", "src/a.ts"), toolMessage("edit", "src/c.ts")]
    const ops = SessionCompaction.extractFileOps(messages, previous)
    expect(ops.read).toEqual(["legacy.ts", "src/a.ts"])
    expect(ops.modified).toEqual(["src/b.ts", "src/c.ts"])
  })

  test("ignores non-tool, pending, and failed messages and missing paths", () => {
    const messages: SessionMessage.Message[] = [
      user("hello"),
      {
        id: "msg_pending",
        type: "assistant",
        agent: "build",
        model: { id: "m", providerID: "p", variant: "default" },
        content: [
          {
            type: "tool",
            id: "t",
            name: "read",
            time: { created: TS },
            state: { status: "pending", input: "" },
          },
        ],
        time: { created: TS },
      } as unknown as SessionMessage.Assistant,
      {
        id: "msg_nopath",
        type: "assistant",
        agent: "build",
        model: { id: "m", providerID: "p", variant: "default" },
        content: [
          {
            type: "tool",
            id: "t2",
            name: "write",
            time: { created: TS },
            state: {
              status: "completed",
              input: { command: "no path here" },
              structured: {},
              content: [],
            },
          },
        ],
        time: { created: TS },
      } as unknown as SessionMessage.Assistant,
    ]
    const ops = SessionCompaction.extractFileOps(messages)
    expect(ops.read).toEqual([])
    expect(ops.modified).toEqual([])
  })
})
