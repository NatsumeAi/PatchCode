import { describe, expect, test } from "bun:test"
import {
  getMemoryStats,
  recordConsolidate,
  resetMemoryStatsForTests,
} from "../../src/memory/observability"

describe("Memory observability", () => {
  test("recordConsolidate does not demote completed to nothing (dual-root)", () => {
    resetMemoryStatsForTests()
    recordConsolidate({ status: "completed", sourcesMerged: 2 })
    expect(getMemoryStats().lastConsolidateStatus).toBe("completed")
    expect(getMemoryStats().sourcesMerged).toBe(2)
    // Global pass with nothing to do must not overwrite workspace success.
    recordConsolidate({ status: "nothing", reason: "no-sources" })
    expect(getMemoryStats().lastConsolidateStatus).toBe("completed")
    expect(getMemoryStats().sourcesMerged).toBe(2)
  })

  test("recordConsolidate can upgrade nothing to completed", () => {
    resetMemoryStatsForTests()
    recordConsolidate({ status: "nothing", reason: "no-sources" })
    recordConsolidate({ status: "completed", sourcesMerged: 1 })
    expect(getMemoryStats().lastConsolidateStatus).toBe("completed")
    expect(getMemoryStats().sourcesMerged).toBe(1)
  })
})
