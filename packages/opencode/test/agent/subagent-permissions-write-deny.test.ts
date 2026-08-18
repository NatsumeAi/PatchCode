import { it, expect } from "bun:test"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { Permission } from "../../src/permission"
import type { Agent } from "../../src/agent/agent"

// Adapts Plan 3 Task 8's spec intent to the REAL `deriveSubagentSessionPermission`
// signature (spec's fictional `{parentWritable, parentDepth, subagentWritable}`
// conflicts with the call site in task.ts). The spec note "假设路径; 实施者核实"
// + its hard constraint (no `as any`, strict types) mandate this adaptation.
//
// Semantics:
// - `subagent.writable` explicit `false` → hard non-writable (deny even if own
//   permission grants edit)
// - `subagent.writable` explicit `true` → hard writable (no write-deny)
// - `subagent.writable` undefined → derived from the subagent's OWN permission:
//   grants `edit` → writable (preserves existing executor subagents); otherwise
//   non-writable (L7 write 单线程化 default: review subagents are read-only)

function makeAgent(overrides: Partial<Agent.Info> = {}): Agent.Info {
  return {
    name: "test-subagent",
    mode: "subagent",
    permission: [],
    options: {},
    ...overrides,
  }
}

it("subagent without edit grant (default) → Write/Edit deny in derived ruleset", () => {
  const perms = deriveSubagentSessionPermission({
    parentSessionPermission: [],
    subagent: makeAgent(),
  })
  expect(perms).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
})

it("subagent with own edit grant → no edit deny (backward compat, executor)", () => {
  const subagent = makeAgent({ permission: [...Permission.fromConfig({ edit: "allow" })] })
  const perms = deriveSubagentSessionPermission({ parentSessionPermission: [], subagent })
  expect(perms.some((rule) => rule.action === "edit" && rule.effect === "deny")).toBe(false)
})

it("explicit writable=true → no edit deny even without own grant", () => {
  const subagent = makeAgent({ writable: true })
  const perms = deriveSubagentSessionPermission({ parentSessionPermission: [], subagent })
  expect(perms.some((rule) => rule.action === "edit" && rule.effect === "deny")).toBe(false)
})

it("explicit writable=false → edit deny even with own edit grant (flag overrides)", () => {
  const subagent = makeAgent({ writable: false, permission: [...Permission.fromConfig({ edit: "allow" })] })
  const perms = deriveSubagentSessionPermission({ parentSessionPermission: [], subagent })
  expect(perms).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
})

it("non-writable subagent → all bash commands denied", () => {
  const subagent = makeAgent()
  const perms = deriveSubagentSessionPermission({ parentSessionPermission: [], subagent })
  const merged = Permission.merge(subagent.permission, perms)
  expect(Permission.evaluate("bash", "git status", merged).effect).toBe("deny")
  expect(Permission.evaluate("bash", "rm -rf /", merged).effect).toBe("deny")
  expect(Permission.evaluate("bash", "echo hi > out.txt", merged).effect).toBe("deny")
})

it("non-writable subagent → shell indirection and write-capable executables denied", () => {
  const subagent = makeAgent()
  const perms = deriveSubagentSessionPermission({ parentSessionPermission: [], subagent })
  const merged = Permission.merge(subagent.permission, perms)
  const bypasses = [
    "bash -c 'printf hacked > out.txt'",
    "sh -c 'rm -rf workspace'",
    "find . -exec touch created.txt \\\;",
    "truncate -s 0 existing.txt",
    "node -e \"require('fs').writeFileSync('out.txt', 'hacked')\"",
    "python3 -c \"open('out.txt', 'w').write('hacked')\"",
    "git reset --hard HEAD",
    "git checkout -- .",
  ]

  for (const command of bypasses) {
    expect(Permission.evaluate("bash", command, merged).effect).toBe("deny")
  }
})

it("writable subagent → bash write commands NOT denied", () => {
  const subagent = makeAgent({ writable: true })
  const perms = deriveSubagentSessionPermission({ parentSessionPermission: [], subagent })
  const merged = Permission.merge(subagent.permission, perms)
  expect(Permission.evaluate("bash", "rm -rf /", merged).effect).not.toBe("deny")
})

it("non-writable subagent still inherits parent session deny rules", () => {
  const subagent = makeAgent()
  const parentSessionPermission: Permission.Ruleset = Permission.fromConfig({ bash: "deny" })
  const perms = deriveSubagentSessionPermission({ parentSessionPermission, subagent })
  expect(perms).toContainEqual({ action: "bash", resource: "*", effect: "deny" })
})
