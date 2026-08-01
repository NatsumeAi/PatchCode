import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { DoomLoop } from "../../src/session/loop-control/doom-loop"

describe("DoomLoop", () => {
  it("encodes and decodes a TailRepetition signal", () => {
    const signal: DoomLoop.DoomLoopSignal = {
      channel: "stdout",
      signal: { kind: "TailRepetition", count: 3 },
    }
    const encoded = Schema.encodeSync(DoomLoop.DoomLoopSignal)(signal)
    const decoded = Schema.decodeSync(DoomLoop.DoomLoopSignal)(encoded)
    expect(decoded).toEqual(signal)
  })

  it("encodes and decodes a LowLogprob signal", () => {
    const signal: DoomLoop.DoomLoopSignal = {
      channel: "stderr",
      signal: { kind: "LowLogprob" },
    }
    const decoded = Schema.decodeSync(DoomLoop.DoomLoopSignal)(Schema.encodeSync(DoomLoop.DoomLoopSignal)(signal))
    expect(decoded).toEqual(signal)
  })

  it("encodes and decodes an Unknown signal with reason", () => {
    const signal: DoomLoop.DoomLoopSignal = {
      channel: "system",
      signal: { kind: "Unknown", reason: "no progress" },
    }
    const decoded = Schema.decodeSync(DoomLoop.DoomLoopSignal)(Schema.encodeSync(DoomLoop.DoomLoopSignal)(signal))
    expect(decoded).toEqual(signal)
  })

  it("rejects a signal with an invalid kind", () => {
    expect(() =>
      Schema.decodeSync(DoomLoop.DoomLoopSignal)({
        channel: "stdout",
        signal: { kind: "Bogus" as "TailRepetition", count: 1 },
      }),
    ).toThrow()
  })
})
