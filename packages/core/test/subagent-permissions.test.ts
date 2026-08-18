import { describe, expect, test } from "bun:test"
import { Agent } from "../src/agent"
import { deriveSubagentPermission } from "../src/session/subagent-permissions"
import { Permission } from "@opencode-ai/schema/permission"

const agent = (permissions: Permission.Ruleset): Agent.Info =>
  Agent.Info.make({
    id: Agent.ID.make("test-agent"),
    request: { headers: {}, body: {} },
    mode: "subagent",
    hidden: false,
    permissions,
  })

const writableAgent = agent([{ action: "edit", resource: "*", effect: "allow" }])
const readOnlyAgent = agent([{ action: "read", resource: "*", effect: "allow" }])
const parentDeny: Permission.Ruleset = [{ action: "bash", resource: "*", effect: "deny" }]

describe("deriveSubagentPermission", () => {
  test("non-writable subagent denies edit and bash (write serialization)", () => {
    const rules = deriveSubagentPermission({ parentPermissions: [], subagent: readOnlyAgent })
    expect(rules).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
    expect(rules).toContainEqual({ action: "bash", resource: "*", effect: "deny" })
  })

  test("writable subagent keeps edit allowed", () => {
    const rules = deriveSubagentPermission({ parentPermissions: [], subagent: writableAgent })
    expect(rules.some((r) => r.action === "edit" && r.effect === "deny")).toBe(false)
  })

  test("todowrite and task denied by default (recursion guard)", () => {
    const rules = deriveSubagentPermission({ parentPermissions: [], subagent: readOnlyAgent })
    expect(rules).toContainEqual({ action: "todowrite", resource: "*", effect: "deny" })
    expect(rules).toContainEqual({ action: "task", resource: "*", effect: "deny" })
  })

  test("parent deny rules are inherited", () => {
    const rules = deriveSubagentPermission({ parentPermissions: parentDeny, subagent: writableAgent })
    expect(rules).toContainEqual({ action: "bash", resource: "*", effect: "deny" })
  })

  test("read-only capability denies all write paths including bash", () => {
    const rules = deriveSubagentPermission({ parentPermissions: [], subagent: writableAgent, capability: "read-only" })
    for (const action of ["edit", "write", "apply_patch", "bash"]) {
      expect(rules).toContainEqual({ action, resource: "*", effect: "deny" })
    }
  })

  test("read-write capability denies bash but keeps edit", () => {
    const rules = deriveSubagentPermission({ parentPermissions: [], subagent: writableAgent, capability: "read-write" })
    expect(rules).toContainEqual({ action: "bash", resource: "*", effect: "deny" })
    expect(rules.some((r) => r.action === "edit" && r.effect === "deny")).toBe(false)
  })

  test("execute capability allows bash but denies edit/write", () => {
    const rules = deriveSubagentPermission({ parentPermissions: [], subagent: writableAgent, capability: "execute" })
    expect(rules.some((r) => r.action === "bash" && r.effect === "deny")).toBe(false)
    expect(rules).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
    expect(rules).toContainEqual({ action: "write", resource: "*", effect: "deny" })
  })

  test("all capability adds no capability-specific filtering", () => {
    const rules = deriveSubagentPermission({ parentPermissions: [], subagent: writableAgent, capability: "all" })
    // Default recursion guards (todowrite/task deny) still apply, but no
    // capability-driven edit/write/apply_patch/bash denials.
    expect(rules.some((r) => r.action === "edit" && r.effect === "deny")).toBe(false)
    expect(rules.some((r) => r.action === "bash" && r.effect === "deny")).toBe(false)
    expect(rules.some((r) => r.action === "write" && r.effect === "deny")).toBe(false)
  })
})
