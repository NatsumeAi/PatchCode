import { describe, expect, test } from "bun:test"
import { parseStatusText } from "../../src/feature-plugins/sidebar/loop-panel"

describe("loop panel status parser", () => {
  test("reads worker, verifier, timer, and spawn edges from /loop status", () => {
    const snap = parseStatusText(
      [
        "Goal       : ship the loop module",
        "Worker     : waiting",
        "Verifier   : Fresh (no audits yet)",
        "Budget     : consumed 3 / cap 90  (3%)",
        "Breaker    : Closed",
        "SpawnEdges : 2 open",
        "Timer      : loopTimer 24h; stopReminder 5m idle; running",
        "Terminal   : aborted (reason: user_abort)",
        "Last events: AbortRequested",
      ].join("\n"),
    )
    expect(snap.goal).toBe("ship the loop module")
    expect(snap.worker).toBe("waiting")
    expect(snap.verifier).toBe("Fresh (no audits yet)")
    expect(snap.timer).toContain("loopTimer 24h")
    expect(snap.edges).toBe("2 open")
    expect(snap.terminal).toContain("user_abort")
    expect(snap.breaker).toBe("Closed")
  })
})
