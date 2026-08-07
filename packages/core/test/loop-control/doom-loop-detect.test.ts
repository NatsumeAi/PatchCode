import { expect, test } from "bun:test"
import { DoomLoop } from "../../src/session/loop-control/doom-loop"

test("detectTailRepetition fires on 3 identical claims", () => {
  const signal = DoomLoop.detectTailRepetition([
    "I fixed the bug in parser.ts",
    "I fixed the bug in parser.ts",
    "I fixed the bug in parser.ts",
  ])
  expect(signal?.signal.kind).toBe("TailRepetition")
})

test("detectTailRepetition ignores short claims", () => {
  expect(DoomLoop.detectTailRepetition(["ok", "ok", "ok"])).toBeUndefined()
})

test("detectRepeatedToolFingerprint fires on same tool name streak", () => {
  const signal = DoomLoop.detectRepeatedToolFingerprint(
    Array.from({ length: 12 }, () => "bash:call-1"),
    12,
  )
  expect(signal?.channel).toBe("tool_call")
})
