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
  const signal = DoomLoop.detectRepeatedToolFingerprint(
    Array.from({ length: DoomLoop.HARD_ABORT_THRESHOLD }, () => fp),
    DoomLoop.HARD_ABORT_THRESHOLD,
  )
  expect(signal?.channel).toBe("tool_call")
})

test("detectRepeatedToolFingerprint asks at official 3 identical calls", () => {
  const fp = DoomLoop.toolFingerprint("bash", { command: "ls" })
  expect(DoomLoop.detectRepeatedToolFingerprint(Array.from({ length: DoomLoop.ASK_THRESHOLD }, () => fp), DoomLoop.ASK_THRESHOLD)?.channel).toBe(
    "tool_call",
  )
})

test("toolFingerprint differs when args differ", () => {
  expect(DoomLoop.toolFingerprint("bash", { command: "ls" })).not.toBe(
    DoomLoop.toolFingerprint("bash", { command: "pwd" }),
  )
})

test("toolFingerprint stable under key order", () => {
  expect(DoomLoop.toolFingerprint("read", { a: 1, b: 2 })).toBe(DoomLoop.toolFingerprint("read", { b: 2, a: 1 }))
})
