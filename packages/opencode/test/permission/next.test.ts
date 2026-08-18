import { test, expect } from "bun:test"
import os from "os"
import { Permission } from "../../src/permission"

// fromConfig tests

test("fromConfig - string value becomes wildcard rule", () => {
  const result = Permission.fromConfig({ bash: "allow" })
  expect(result).toEqual([{ action: "bash", resource: "*", effect: "allow" }])
})

test("fromConfig - object value converts to rules array", () => {
  const result = Permission.fromConfig({ bash: { "*": "allow", rm: "deny" } })
  expect(result).toEqual([
    { action: "bash", resource: "*", effect: "allow" },
    { action: "bash", resource: "rm", effect: "deny" },
  ])
})

test("fromConfig - mixed string and object values", () => {
  const result = Permission.fromConfig({
    bash: { "*": "allow", rm: "deny" },
    edit: "allow",
    webfetch: "ask",
  })
  expect(result).toEqual([
    { action: "bash", resource: "*", effect: "allow" },
    { action: "bash", resource: "rm", effect: "deny" },
    { action: "edit", resource: "*", effect: "allow" },
    { action: "webfetch", resource: "*", effect: "ask" },
  ])
})

test("fromConfig - empty object", () => {
  const result = Permission.fromConfig({})
  expect(result).toEqual([])
})

test("fromConfig - expands tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  expect(result).toEqual([{ action: "external_directory", resource: `${os.homedir()}/projects/*`, effect: "allow" }])
})

test("fromConfig - expands $HOME to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  expect(result).toEqual([{ action: "external_directory", resource: `${os.homedir()}/projects/*`, effect: "allow" }])
})

test("fromConfig - expands $HOME without trailing slash", () => {
  const result = Permission.fromConfig({ external_directory: { $HOME: "allow" } })
  expect(result).toEqual([{ action: "external_directory", resource: os.homedir(), effect: "allow" }])
})

test("fromConfig - does not expand tilde in middle of path", () => {
  const result = Permission.fromConfig({ external_directory: { "/some/~/path": "allow" } })
  expect(result).toEqual([{ action: "external_directory", resource: "/some/~/path", effect: "allow" }])
})

// Permission precedence follows config insertion order. `evaluate()` uses the
// last matching rule, so later config entries intentionally override earlier
// entries even when a wildcard appears after a specific permission.

test("fromConfig - preserves top-level config key order", () => {
  const wildcardFirst = Permission.fromConfig({ "*": "deny", bash: "allow" })
  const specificFirst = Permission.fromConfig({ bash: "allow", "*": "deny" })

  expect(wildcardFirst.map((r) => r.action)).toEqual(["*", "bash"])
  expect(specificFirst.map((r) => r.action)).toEqual(["bash", "*"])

  expect(Permission.evaluate("bash", "ls", wildcardFirst).effect).toBe("allow")
  expect(Permission.evaluate("bash", "ls", specificFirst).effect).toBe("deny")
})

test("fromConfig - wildcard acts as fallback when it appears before specifics", () => {
  const ruleset = Permission.fromConfig({ "*": "ask", bash: "allow" })
  expect(Permission.evaluate("edit", "foo.ts", ruleset).effect).toBe("ask")
  expect(Permission.evaluate("bash", "ls", ruleset).effect).toBe("allow")
})

test("fromConfig - top-level ordering is not sorted by wildcard specificity", () => {
  const ruleset = Permission.fromConfig({
    bash: "allow",
    "*": "ask",
    edit: "deny",
    "mcp_*": "allow",
  })
  expect(ruleset.map((r) => r.action)).toEqual(["bash", "*", "edit", "mcp_*"])
})

test("fromConfig - sub-pattern insertion order inside a tool key is preserved", () => {
  const ruleset = Permission.fromConfig({ bash: { "*": "deny", "git *": "allow" } })
  expect(ruleset.map((r) => r.resource)).toEqual(["*", "git *"])
  expect(Permission.evaluate("bash", "rm foo", ruleset).effect).toBe("deny")
  expect(Permission.evaluate("bash", "git status", ruleset).effect).toBe("allow")
})

test("fromConfig - documented fallback-first example", () => {
  const ruleset = Permission.fromConfig({ "*": "ask", bash: "allow", edit: "deny" })
  expect(Permission.evaluate("bash", "ls", ruleset).effect).toBe("allow")
  expect(Permission.evaluate("edit", "foo.ts", ruleset).effect).toBe("deny")
  expect(Permission.evaluate("read", "foo.ts", ruleset).effect).toBe("ask")
})

test("fromConfig - expands exact tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~": "allow" } })
  expect(result).toEqual([{ action: "external_directory", resource: os.homedir(), effect: "allow" }])
})

test("evaluate - matches expanded tilde pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.effect).toBe("allow")
})

test("evaluate - matches expanded $HOME pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.effect).toBe("allow")
})

// merge tests

test("merge - simple concatenation", () => {
  const result = Permission.merge(
    [{ action: "bash", resource: "*", effect: "allow" }],
    [{ action: "bash", resource: "*", effect: "deny" }],
  )
  expect(result).toEqual([
    { action: "bash", resource: "*", effect: "allow" },
    { action: "bash", resource: "*", effect: "deny" },
  ])
})

test("merge - adds new permission", () => {
  const result = Permission.merge(
    [{ action: "bash", resource: "*", effect: "allow" }],
    [{ action: "edit", resource: "*", effect: "deny" }],
  )
  expect(result).toEqual([
    { action: "bash", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
  ])
})

test("merge - concatenates rules for same permission", () => {
  const result = Permission.merge(
    [{ action: "bash", resource: "foo", effect: "ask" }],
    [{ action: "bash", resource: "*", effect: "deny" }],
  )
  expect(result).toEqual([
    { action: "bash", resource: "foo", effect: "ask" },
    { action: "bash", resource: "*", effect: "deny" },
  ])
})

test("merge - multiple rulesets", () => {
  const result = Permission.merge(
    [{ action: "bash", resource: "*", effect: "allow" }],
    [{ action: "bash", resource: "rm", effect: "ask" }],
    [{ action: "edit", resource: "*", effect: "allow" }],
  )
  expect(result).toEqual([
    { action: "bash", resource: "*", effect: "allow" },
    { action: "bash", resource: "rm", effect: "ask" },
    { action: "edit", resource: "*", effect: "allow" },
  ])
})

test("merge - empty ruleset does nothing", () => {
  const result = Permission.merge([{ action: "bash", resource: "*", effect: "allow" }], [])
  expect(result).toEqual([{ action: "bash", resource: "*", effect: "allow" }])
})

test("merge - preserves rule order", () => {
  const result = Permission.merge(
    [
      { action: "edit", resource: "src/*", effect: "allow" },
      { action: "edit", resource: "src/secret/*", effect: "deny" },
    ],
    [{ action: "edit", resource: "src/secret/ok.ts", effect: "allow" }],
  )
  expect(result).toEqual([
    { action: "edit", resource: "src/*", effect: "allow" },
    { action: "edit", resource: "src/secret/*", effect: "deny" },
    { action: "edit", resource: "src/secret/ok.ts", effect: "allow" },
  ])
})

test("merge - config permission overrides default ask", () => {
  const defaults: Permission.Ruleset = [{ action: "*", resource: "*", effect: "ask" }]
  const config: Permission.Ruleset = [{ action: "bash", resource: "*", effect: "allow" }]
  const merged = Permission.merge(defaults, config)

  expect(Permission.evaluate("bash", "ls", merged).effect).toBe("allow")
  expect(Permission.evaluate("edit", "foo.ts", merged).effect).toBe("ask")
})

test("merge - config ask overrides default allow", () => {
  const defaults: Permission.Ruleset = [{ action: "bash", resource: "*", effect: "allow" }]
  const config: Permission.Ruleset = [{ action: "bash", resource: "*", effect: "ask" }]
  const merged = Permission.merge(defaults, config)

  expect(Permission.evaluate("bash", "ls", merged).effect).toBe("ask")
})

// evaluate tests

test("evaluate - exact pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ action: "bash", resource: "rm", effect: "deny" }])
  expect(result.effect).toBe("deny")
})

test("evaluate - wildcard pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ action: "bash", resource: "*", effect: "allow" }])
  expect(result.effect).toBe("allow")
})

test("evaluate - last matching rule wins", () => {
  const result = Permission.evaluate("bash", "rm", [
    { action: "bash", resource: "*", effect: "allow" },
    { action: "bash", resource: "rm", effect: "deny" },
  ])
  expect(result.effect).toBe("deny")
})

test("evaluate - last matching rule wins (wildcard after specific)", () => {
  const result = Permission.evaluate("bash", "rm", [
    { action: "bash", resource: "rm", effect: "deny" },
    { action: "bash", resource: "*", effect: "allow" },
  ])
  expect(result.effect).toBe("allow")
})

test("evaluate - glob pattern match", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [{ action: "edit", resource: "src/*", effect: "allow" }])
  expect(result.effect).toBe("allow")
})

test("evaluate - last matching glob wins", () => {
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { action: "edit", resource: "src/*", effect: "deny" },
    { action: "edit", resource: "src/components/*", effect: "allow" },
  ])
  expect(result.effect).toBe("allow")
})

test("evaluate - order matters for specificity", () => {
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { action: "edit", resource: "src/components/*", effect: "allow" },
    { action: "edit", resource: "src/*", effect: "deny" },
  ])
  expect(result.effect).toBe("deny")
})

test("evaluate - unknown permission returns ask", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { action: "bash", resource: "*", effect: "allow" },
  ])
  expect(result.effect).toBe("ask")
})

test("evaluate - empty ruleset returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.effect).toBe("ask")
})

test("evaluate - no matching pattern returns ask", () => {
  const result = Permission.evaluate("edit", "etc/passwd", [{ action: "edit", resource: "src/*", effect: "allow" }])
  expect(result.effect).toBe("ask")
})

test("evaluate - empty rules array returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.effect).toBe("ask")
})

test("evaluate - multiple matching patterns, last wins", () => {
  const result = Permission.evaluate("edit", "src/secret.ts", [
    { action: "edit", resource: "*", effect: "ask" },
    { action: "edit", resource: "src/*", effect: "allow" },
    { action: "edit", resource: "src/secret.ts", effect: "deny" },
  ])
  expect(result.effect).toBe("deny")
})

test("evaluate - non-matching patterns are skipped", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { action: "edit", resource: "*", effect: "ask" },
    { action: "edit", resource: "test/*", effect: "deny" },
    { action: "edit", resource: "src/*", effect: "allow" },
  ])
  expect(result.effect).toBe("allow")
})

test("evaluate - exact match at end wins over earlier wildcard", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { action: "bash", resource: "*", effect: "allow" },
    { action: "bash", resource: "/bin/rm", effect: "deny" },
  ])
  expect(result.effect).toBe("deny")
})

test("evaluate - wildcard at end overrides earlier exact match", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { action: "bash", resource: "/bin/rm", effect: "deny" },
    { action: "bash", resource: "*", effect: "allow" },
  ])
  expect(result.effect).toBe("allow")
})

// wildcard permission tests

test("evaluate - wildcard permission matches any permission", () => {
  const result = Permission.evaluate("bash", "rm", [{ action: "*", resource: "*", effect: "deny" }])
  expect(result.effect).toBe("deny")
})

test("evaluate - wildcard permission with specific pattern", () => {
  const result = Permission.evaluate("bash", "rm", [{ action: "*", resource: "rm", effect: "deny" }])
  expect(result.effect).toBe("deny")
})

test("evaluate - glob permission pattern", () => {
  const result = Permission.evaluate("mcp_server_tool", "anything", [
    { action: "mcp_*", resource: "*", effect: "allow" },
  ])
  expect(result.effect).toBe("allow")
})

test("evaluate - specific permission and wildcard permission combined", () => {
  const result = Permission.evaluate("bash", "rm", [
    { action: "*", resource: "*", effect: "deny" },
    { action: "bash", resource: "*", effect: "allow" },
  ])
  expect(result.effect).toBe("allow")
})

test("evaluate - wildcard permission does not match when specific exists", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { action: "*", resource: "*", effect: "deny" },
    { action: "edit", resource: "src/*", effect: "allow" },
  ])
  expect(result.effect).toBe("allow")
})

test("evaluate - multiple matching permission patterns combine rules", () => {
  const result = Permission.evaluate("mcp_dangerous", "anything", [
    { action: "*", resource: "*", effect: "ask" },
    { action: "mcp_*", resource: "*", effect: "allow" },
    { action: "mcp_dangerous", resource: "*", effect: "deny" },
  ])
  expect(result.effect).toBe("deny")
})

test("evaluate - wildcard permission fallback for unknown tool", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { action: "*", resource: "*", effect: "ask" },
    { action: "bash", resource: "*", effect: "allow" },
  ])
  expect(result.effect).toBe("ask")
})

test("evaluate - later wildcard permission can override earlier specific permission", () => {
  const result = Permission.evaluate("bash", "rm", [
    { action: "bash", resource: "*", effect: "allow" },
    { action: "*", resource: "*", effect: "deny" },
  ])
  expect(result.effect).toBe("deny")
})

test("evaluate - merges multiple rulesets", () => {
  const config: Permission.Ruleset = [{ action: "bash", resource: "*", effect: "allow" }]
  const approved: Permission.Ruleset = [{ action: "bash", resource: "rm", effect: "deny" }]
  const result = Permission.evaluate("bash", "rm", config, approved)
  expect(result.effect).toBe("deny")
})

// disabled tests

test("disabled - returns empty set when all tools allowed", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ action: "*", resource: "*", effect: "allow" }])
  expect(result.size).toBe(0)
})

test("disabled - disables tool when denied", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { action: "*", resource: "*", effect: "allow" },
      { action: "bash", resource: "*", effect: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(false)
  expect(result.has("read")).toBe(false)
})

test("disabled - disables edit/write/apply_patch when edit denied", () => {
  const result = Permission.disabled(
    ["edit", "write", "apply_patch", "bash"],
    [
      { action: "*", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
    ],
  )
  expect(result.has("edit")).toBe(true)
  expect(result.has("write")).toBe(true)
  expect(result.has("apply_patch")).toBe(true)
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when partially denied", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { action: "bash", resource: "*", effect: "allow" },
      { action: "bash", resource: "rm *", effect: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when action is ask", () => {
  const result = Permission.disabled(["bash", "edit"], [{ action: "*", resource: "*", effect: "ask" }])
  expect(result.size).toBe(0)
})

test("disabled - does not disable when specific allow after wildcard deny", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { action: "bash", resource: "*", effect: "deny" },
      { action: "bash", resource: "echo *", effect: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when wildcard allow after deny", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { action: "bash", resource: "rm *", effect: "deny" },
      { action: "bash", resource: "*", effect: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - disables multiple tools", () => {
  const result = Permission.disabled(
    ["bash", "edit", "webfetch"],
    [
      { action: "bash", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "*", effect: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("webfetch")).toBe(true)
})

test("disabled - wildcard permission denies all tools", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ action: "*", resource: "*", effect: "deny" }])
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

test("disabled - specific allow overrides wildcard deny", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { action: "*", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

