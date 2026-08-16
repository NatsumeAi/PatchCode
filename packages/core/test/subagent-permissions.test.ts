import { describe, expect, test } from "bun:test"
import { AgentV2 } from "../src/agent"
import { deriveSubagentPermission, toLegacyRule, toCurrentRule } from "../src/session/subagent-permissions"
import { Permission } from "@opencode-ai/schema/permission"
import { PermissionV1 } from "@opencode-ai/schema/permission-legacy"

const agent = (permissions: Permission.Ruleset): AgentV2.Info =>
  AgentV2.Info.make({
    id: AgentV2.ID.make("test-agent"),
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

describe("V1 ↔ V2 rule conversion", () => {
  test("toCurrentRule maps permission/pattern/action → action/resource/effect", () => {
    const v1: PermissionV1.Rule = { permission: "edit", pattern: "*.ts", action: "deny" }
    expect(toCurrentRule(v1)).toEqual({ action: "edit", resource: "*.ts", effect: "deny" })
  })

  test("toLegacyRule maps back", () => {
    const v2: Permission.Rule = { action: "bash", resource: "*", effect: "ask" }
    expect(toLegacyRule(v2)).toEqual({ permission: "bash", pattern: "*", action: "ask" })
  })

  test("round trip preserves rule", () => {
    const original: PermissionV1.Rule = { permission: "read", pattern: "src/**", action: "allow" }
    expect(toLegacyRule(toCurrentRule(original))).toEqual(original)
  })
})
