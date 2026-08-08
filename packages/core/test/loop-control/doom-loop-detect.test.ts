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

test("detectRepeatedToolFingerprint fires on same name+args fingerprint streak", () => {
  const fp = DoomLoop.toolFingerprint("bash", { command: "ls" })
  const signal = DoomLoop.detectRepeatedToolFingerprint(Array.from({ length: 8 }, () => fp), 8)
  expect(signal?.channel).toBe("tool_call")
})

test("toolFingerprint differs when args differ", () => {
  expect(DoomLoop.toolFingerprint("bash", { command: "ls" })).not.toBe(
    DoomLoop.toolFingerprint("bash", { command: "pwd" }),
  )
})

test("toolFingerprint stable under key order", () => {
  expect(DoomLoop.toolFingerprint("read", { a: 1, b: 2 })).toBe(DoomLoop.toolFingerprint("read", { b: 2, a: 1 }))
})
