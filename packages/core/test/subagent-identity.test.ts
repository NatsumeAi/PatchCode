import { describe, expect, test } from "bun:test"
import { validateResumeIdentity } from "../src/session/subagent-identity"
import { SessionSchema } from "../src/session/schema"
import { AgentV2 } from "../src/agent"

const parentID = SessionSchema.ID.make("ses_parent")
const childID = SessionSchema.ID.make("ses_child")

const child = (overrides: Partial<Parameters<typeof makeChild>[0]> = {}) => makeChild(overrides)

function makeChild(overrides: {
  id?: SessionSchema.ID
  parentID?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: { id: string; providerID: string; variant?: string }
}): SessionSchema.Info {
  return {
    id: overrides.id ?? childID,
    projectID: "prj_test",
    title: "t",
    parentID: overrides.parentID ?? parentID,
    agent: overrides.agent ?? AgentV2.ID.make("explore"),
    model: overrides.model,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: { directory: "/tmp/x", workspaceID: undefined },
    time: { created: new Date(0), updated: new Date(0) },
  } as unknown as SessionSchema.Info
}

describe("validateResumeIdentity", () => {
  test("matches when parent and agent match", () => {
    const result = validateResumeIdentity({
      child: child(),
      parentSessionID: parentID,
      subagentType: "explore",
    })
    expect(result.ok).toBe(true)
  })

  test("rejects when parentID does not match", () => {
    const result = validateResumeIdentity({
      child: child({ parentID: SessionSchema.ID.make("ses_other") }),
      parentSessionID: parentID,
      subagentType: "explore",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("not spawned by this session")
  })

  test("rejects when agent name does not match", () => {
    const result = validateResumeIdentity({
      child: child({ agent: AgentV2.ID.make("general") }),
      parentSessionID: parentID,
      subagentType: "explore",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('agent "general"')
  })

  test("soft-ignores requested model mismatch and returns child model", () => {
    const result = validateResumeIdentity({
      child: child({ model: { id: "model-a", providerID: "prov-a" } }),
      parentSessionID: parentID,
      subagentType: "explore",
      requestedModel: { modelID: "model-b", providerID: "prov-b" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(String(result.childModel?.id)).toBe("model-a")
  })

  test("rejects persona name mismatch on resume", () => {
    const result = validateResumeIdentity({
      child: child(),
      parentSessionID: parentID,
      subagentType: "explore",
      requestedPersona: "other",
      priorPersonaName: "researcher",
    })
    expect(result.ok).toBe(false)
  })

  test("allows resume without explicit persona (inherits prior)", () => {
    const result = validateResumeIdentity({
      child: child(),
      parentSessionID: parentID,
      subagentType: "explore",
      priorPersonaName: "researcher",
    })
    expect(result.ok).toBe(true)
  })
})
