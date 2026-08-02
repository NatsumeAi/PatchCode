import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

describe("SessionCompaction.buildPrompt v3 skeleton", () => {
  test("new-summary prompt keeps the fixed section order: instruction, template, numbered list, conversation", () => {
    const prompt = SessionCompaction.buildPrompt({
      numberedItems: "[1] (2.0%) [User]: hello",
      context: ["serialized history part"],
    })
    const instruction = prompt.indexOf("Create a new anchored summary")
    const template = prompt.indexOf("## Objective")
    const conversation = prompt.indexOf("<conversation>")
    const numbered = prompt.indexOf("<numbered-context>")
    expect(instruction).toBeGreaterThanOrEqual(0)
    expect(template).toBeGreaterThan(instruction)
    // the numbered selection list is the most volatile section → last (cache convention)
    expect(conversation).toBeGreaterThan(template)
    expect(numbered).toBeGreaterThan(conversation)
    expect(prompt).toContain("</conversation>")
    expect(prompt).toContain("[1] (2.0%) [User]: hello")
    expect(prompt).toContain("serialized history part")
  })

  test("update prompt requires PRESERVE/ADD/UPDATE rules with the previous summary", () => {
    const prompt = SessionCompaction.buildPrompt({
      previousSummary: "old summary",
      context: ["history"],
    })
    expect(prompt).toContain("PRESERVE")
    expect(prompt).toContain("ADD")
    expect(prompt).toContain("UPDATE")
    expect(prompt).toContain("<previous-summary>")
    expect(prompt).toContain("old summary")
    expect(prompt).toContain("</previous-summary>")
    // the previous summary sits before the template
    expect(prompt.indexOf("<previous-summary>")).toBeLessThan(prompt.indexOf("## Objective"))
  })

  test("numbered list is omitted when there are no selection items", () => {
    const prompt = SessionCompaction.buildPrompt({ context: ["history"] })
    expect(prompt).not.toContain("<numbered-context>")
    expect(prompt).toContain("<conversation>")
    expect(prompt).toContain("history")
  })

  test("summary template sections are preserved", () => {
    const prompt = SessionCompaction.buildPrompt({ context: ["history"] })
    expect(prompt).toContain("## Work State\n### Completed")
    expect(prompt).toContain("### Active")
    expect(prompt).toContain("### Blocked")
    expect(prompt).toContain("## Relevant Files")
  })

  test("the summarization system prompt is exported for the system slot", () => {
    expect(SessionCompaction.SUMMARIZATION_SYSTEM_PROMPT.length).toBeGreaterThan(0)
    expect(SessionCompaction.SUMMARIZATION_SYSTEM_PROMPT).toContain("<selection>")
    // the system prompt instructs structured output, not conversation
    expect(SessionCompaction.SUMMARIZATION_SYSTEM_PROMPT.toLowerCase()).toContain("summary")
  })
})
