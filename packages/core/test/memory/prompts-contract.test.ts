import { describe, expect, test } from "bun:test"
import {
  FLUSH_SYSTEM,
  FLUSH_DELTA_SYSTEM,
  DREAM_SYSTEM,
  SUMMARY_SYSTEM,
  PHASE2_SYSTEM,
} from "../../src/memory/prompts"
import { PHASE2_SYSTEM as reexported } from "../../src/memory/merge-prompt"
import { PRUNE_SYSTEM } from "../../src/memory/prune"
import { priorFlushExcerpt } from "../../src/memory/flush"

describe("Memory prompts contract", () => {
  test("DREAM_SYSTEM (PHASE2) has full consolidation clauses", () => {
    expect(DREAM_SYSTEM).toBe(PHASE2_SYSTEM)
    expect(reexported).toBe(DREAM_SYSTEM)
    const lower = DREAM_SYSTEM.toLowerCase()
    expect(lower).toContain("merge related")
    expect(lower).toContain("contradiction")
    expect(lower).toContain("relative date")
    expect(lower).toContain("greeting")
    expect(lower).toContain("message count")
    expect(lower).toContain("current state")
    expect(lower).toContain("next steps")
    expect(lower).toContain("decision")
    expect(lower).toContain("rationale")
    expect(lower).toContain("architecture")
    expect(lower).toContain("problem")
    expect(lower).toContain("self-contained")
    expect(lower).toContain("untrusted data")
    expect(lower).toContain("do not invent")
    expect(DREAM_SYSTEM).toContain("NO_REPLY")
    expect(lower).toContain("full updated memory.md")
    // Mature prune integration
    expect(lower).toContain("when in doubt")
    expect(lower).toContain("cannot be found")
  })

  test("FLUSH_SYSTEM has Grok sections and NO_REPLY", () => {
    expect(FLUSH_SYSTEM).toContain("Decisions & rationale")
    expect(FLUSH_SYSTEM).toContain("Technical context")
    expect(FLUSH_SYSTEM).toContain("Debugging techniques")
    expect(FLUSH_SYSTEM).toContain("Problems & solutions")
    expect(FLUSH_SYSTEM).toContain("NO_REPLY")
    expect(FLUSH_SYSTEM.toLowerCase()).toContain("untrusted data")
    expect(FLUSH_SYSTEM.toLowerCase()).toContain("secret")
    expect(FLUSH_SYSTEM).toContain("Output ONLY the markdown summary or NO_REPLY")
  })

  test("FLUSH_DELTA_SYSTEM matches Grok-grade denoise + untrusted", () => {
    const lower = FLUSH_DELTA_SYSTEM.toLowerCase()
    expect(lower).toContain("incremental")
    expect(FLUSH_DELTA_SYSTEM).toContain("NEW")
    expect(FLUSH_DELTA_SYSTEM).toContain("NO_REPLY")
    expect(lower).toContain("new decisions since last flush")
    expect(lower).toContain("user preferences")
    expect(lower).toContain("current state")
    expect(lower).toContain("routine changes")
    expect(lower).toContain("untrusted data")
    expect(lower).toContain("secret")
  })

  test("SUMMARY_SYSTEM is self-contained and prefers sparse output", () => {
    const lower = SUMMARY_SYSTEM.toLowerCase()
    expect(lower).toContain("most important")
    expect(lower).toContain("self-contained")
    expect(lower).toContain("bullet")
    expect(lower).toContain("secret")
    expect(lower).toContain("only markdown")
    expect(lower).toContain("do not add instructions")
    expect(lower).toContain("minimal summary")
    expect(SUMMARY_SYSTEM).toContain("NO_REPLY")
  })

  test("PRUNE_SYSTEM is conservative with match-or-skip", () => {
    const lower = PRUNE_SYSTEM.toLowerCase()
    expect(lower).toContain("skip")
    expect(lower).toContain("when in doubt")
    expect(lower).toContain("keep")
    expect(lower).toContain("unrelated")
  })

  test("priorFlushExcerpt only returns when ## Flush marker exists", () => {
    expect(priorFlushExcerpt("# Session x\n- metadata only")).toBeUndefined()
    expect(priorFlushExcerpt("## Flush\n\n## Decisions\n- kept")).toContain("## Flush")
    expect(priorFlushExcerpt(undefined)).toBeUndefined()
  })
})
