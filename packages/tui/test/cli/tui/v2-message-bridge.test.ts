import { expect, test } from "bun:test"
import {
  assistantMessageFromStep,
  sessionMessageToLegacy,
  sessionMeta,
  textPartID,
  userMessageFromPrompt,
  userTextPart,
} from "../../../src/context/v2-message-bridge"
import type { SessionMessage } from "@opencode-ai/sdk/v2"

test("user prompt maps to V1 user message + text part", () => {
  const meta = sessionMeta(undefined)
  const info = userMessageFromPrompt({
    sessionID: "ses_1",
    messageID: "msg_u",
    text: "你好",
    timestamp: 1000,
    meta,
  })
  const part = userTextPart({ sessionID: "ses_1", messageID: "msg_u", text: "你好" })
  expect(info.role).toBe("user")
  expect(info.id).toBe("msg_u")
  expect(part.type).toBe("text")
  expect(part.text).toBe("你好")
  expect(part.messageID).toBe("msg_u")
})

test("assistant step maps parent + model", () => {
  const info = assistantMessageFromStep({
    sessionID: "ses_1",
    messageID: "msg_a",
    agent: "build",
    model: { id: "deepseek-v4-flash-free", providerID: "opencode", variant: "high" },
    timestamp: 2000,
    parentID: "msg_u",
    directory: "/tmp",
  })
  expect(info.role).toBe("assistant")
  expect(info.parentID).toBe("msg_u")
  expect(info.modelID).toBe("deepseek-v4-flash-free")
  expect(info.variant).toBe("high")
})

test("sessionMessageToLegacy converts assistant content parts", () => {
  const message: SessionMessage = {
    id: "msg_a",
    type: "assistant",
    agent: "build",
    model: { id: "m", providerID: "p" },
    time: { created: 1, completed: 2 },
    finish: "stop",
    cost: 0,
    tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
    content: [
      { type: "reasoning", id: "r0", text: "think" },
      { type: "text", id: "t0", text: "DSV4-OK" },
    ],
  }
  const legacy = sessionMessageToLegacy("ses_1", message, sessionMeta(undefined), "msg_u")
  expect(legacy).toBeDefined()
  expect(legacy!.info.role).toBe("assistant")
  if (legacy!.info.role === "assistant") {
    expect(legacy!.info.parentID).toBe("msg_u")
    expect(legacy!.info.time.completed).toBe(2)
  }
  expect(legacy!.parts.map((p) => p.type)).toEqual(["reasoning", "text"])
  expect(legacy!.parts.find((p) => p.type === "text")?.text).toBe("DSV4-OK")
  expect(legacy!.parts[1].id).toBe(textPartID("msg_a", "t0"))
})

test("user files without name fall back to URI basename so TUI never renders undefined", () => {
  const meta = sessionMeta(undefined)
  const result = sessionMessageToLegacy(
    "ses_1",
    {
      id: "msg_u",
      type: "user",
      text: "look",
      files: [{ uri: "/tmp/a.png", mime: "image/png" }],
      time: { created: 1000 },
    },
    meta,
  )
  expect(result).toBeDefined()
  const file = result!.parts.find((part) => part.type === "file")
  expect(file).toBeDefined()
  expect(file!.type).toBe("file")
  expect((file as { filename?: string }).filename).toBe("a.png")
})
