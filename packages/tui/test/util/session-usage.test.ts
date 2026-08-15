import { expect, test } from "bun:test"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { cacheHitRate, firstTokenAt, formatSessionUsageLine } from "../../src/util/session-usage"

const tokens = (input: number, output: number, read = 0, write = 0, reasoning = 0): AssistantMessage["tokens"] => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})

const assistant = (time: AssistantMessage["time"] & { first?: number }, t = tokens(15, 80, 9985)): AssistantMessage =>
  ({
    id: "a1",
    sessionID: "s1",
    role: "assistant",
    parentID: "u1",
    modelID: "m",
    providerID: "p",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: t,
    time,
  }) as AssistantMessage

test("cacheHitRate is cache_read / (cache_read + uncached)", () => {
  expect(cacheHitRate(tokens(15, 1, 9985))).toBeCloseTo(0.9985, 6)
  expect(cacheHitRate(tokens(0, 1, 0))).toBe(0)
})

test("usage line sits beside context percent with cache to two decimals", () => {
  expect(
    formatSessionUsageLine({
      tokens: tokens(15, 80, 9985),
      contextLimit: 100_000,
      cost: 1.25,
      created: 0,
      completed: 2320,
      firstTokenAt: 320,
    }),
  ).toBe("10.1K (10%) · cache 99.85% · TTF 320ms · 40.00 t/s · $1.25")
})

test("omits TTF/TPS/cost when clocks or spend are missing", () => {
  expect(
    formatSessionUsageLine({
      tokens: tokens(100, 10),
      contextLimit: 1000,
      cost: 0,
      created: 0,
    }),
  ).toBe("110 (11%) · cache 0.00%")
})

test("firstTokenAt prefers stamped first over hydrated part starts", () => {
  const parts: Part[] = [
    {
      id: "t1",
      sessionID: "s1",
      messageID: "a1",
      type: "text",
      text: "hi",
      time: { start: 0 },
    },
  ]
  expect(firstTokenAt(assistant({ created: 0, first: 250, completed: 1000 }), parts)).toBe(250)
  expect(firstTokenAt(assistant({ created: 0, completed: 1000 }), parts)).toBeUndefined()
})

test("firstTokenAt uses the earliest live text/reasoning/tool start", () => {
  const parts: Part[] = [
    {
      id: "r1",
      sessionID: "s1",
      messageID: "a1",
      type: "reasoning",
      text: "think",
      time: { start: 180 },
    },
    {
      id: "t1",
      sessionID: "s1",
      messageID: "a1",
      type: "text",
      text: "hi",
      time: { start: 220 },
    },
  ]
  expect(firstTokenAt(assistant({ created: 0 }), parts)).toBe(180)
})
