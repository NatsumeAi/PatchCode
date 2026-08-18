import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { formatHooksStatus } from "@opencode-ai/core/hooks"

const coreSrc = path.resolve(import.meta.dir, "../../src")
const tui = path.resolve(import.meta.dir, "../../../tui/src/component")

describe("W5 inventory", () => {
  test("settleWith dispatches PreToolUse before settle(", () => {
    const text = fs.readFileSync(path.join(coreSrc, "tool/registry.ts"), "utf8")
    expect(text).toContain('event: "PreToolUse"')
    expect(text).toContain("hooksOpt.value.dispatch")
    const pre = text.indexOf('event: "PreToolUse"')
    const settle = text.indexOf("settle(registration.tool")
    expect(pre).toBeGreaterThan(0)
    expect(settle).toBeGreaterThan(pre)
  })

  test("bash PreToolUse is after W2 deny and before permission", () => {
    const text = fs.readFileSync(path.join(coreSrc, "tool/bash.ts"), "utf8")
    const deny = text.indexOf('decision.effect === "deny"')
    const pre = text.indexOf('event: "PreToolUse"')
    const perm = text.indexOf("permission.assert", pre)
    const wrap = text.indexOf("sandbox.wrapSpawn")
    expect(pre).toBeGreaterThan(deny)
    expect(perm).toBeGreaterThan(pre)
    expect(wrap).toBeGreaterThan(perm)
  })

  test("run-command timeout is deny", () => {
    const text = fs.readFileSync(path.join(coreSrc, "hooks/run-command.ts"), "utf8")
    expect(text).toContain('reason: "hook_failed"')
    expect(text).not.toMatch(/timedOut[^\n]*Allow/)
  })

  test("no second trust store under hooks/", () => {
    expect(fs.existsSync(path.join(coreSrc, "hooks/trust.ts"))).toBe(false)
    const load = fs.readFileSync(path.join(coreSrc, "hooks/load.ts"), "utf8")
    expect(load).toContain("Trust.isTrusted")
    expect(load).not.toContain("trusted-folders.json")
  })

  test("production location services include Hooks.node not disabled", () => {
    const text = fs.readFileSync(path.join(coreSrc, "location-services.ts"), "utf8")
    expect(text).toContain("Hooks.node")
    expect(text).not.toContain("Hooks.disabled")
  })

  test("TUI renders loaded hooks and last deny from live list", () => {
    const panel = fs.readFileSync(path.join(tui, "hooks-status.tsx"), "utf8")
    expect(panel).toContain("formatHooksStatus")
    expect(panel).toContain("last deny")
    expect(panel).toContain("/hooks")
    expect(panel).toContain("sync.data.hooks")
    const status = fs.readFileSync(path.join(tui, "dialog-status.tsx"), "utf8")
    expect(status).toContain("HooksStatus")
    const loop = fs.readFileSync(path.resolve(import.meta.dir, "../../../tui/src/feature-plugins/sidebar/loop-panel.tsx"), "utf8")
    expect(loop).toContain("HooksStatus")
    const rendered = formatHooksStatus({
      loaded: [{ id: "global:deny" }],
      lastDeny: { hookId: "global:deny", event: "PreToolUse", reason: "x" },
    })
    expect(rendered).toContain("global:deny")
    expect(rendered.toLowerCase()).toContain("deny")
  })

  test("fire sites exist for the locked event set", () => {
    const files = {
      input: fs.readFileSync(path.join(coreSrc, "session/input.ts"), "utf8"),
      permission: fs.readFileSync(path.join(coreSrc, "permission.ts"), "utf8"),
      compaction: fs.readFileSync(path.join(coreSrc, "session/compaction.ts"), "utf8"),
      llm: fs.readFileSync(path.join(coreSrc, "session/runner/llm.ts"), "utf8"),
      host: fs.readFileSync(path.resolve(import.meta.dir, "../../../opencode/src/tool/tool-host-bridges.ts"), "utf8"),
      local: fs.readFileSync(path.join(coreSrc, "session/execution/local.ts"), "utf8"),
      http: fs.readFileSync(path.resolve(import.meta.dir, "../../../opencode/src/server/routes/instance/httpapi/handlers/session.ts"), "utf8"),
    }
    expect(files.input).toContain("UserPromptSubmit")
    expect(files.permission).toContain("PermissionDenied")
    expect(files.compaction).toContain("PreCompact")
    expect(files.compaction).toContain("PostCompact")
    expect(files.llm).toContain('"Stop"')
    expect(files.host).toContain("SubagentStart")
    expect(files.host).toContain("SubagentStop")
    expect(files.local).toContain("fireSessionStart")
    expect(files.http).toContain("fireSessionEnd")
    expect(files.http).toContain(".handle(\"hooks\"")
  })

  test("plugin host exposes Hooks.register", () => {
    const host = fs.readFileSync(path.join(coreSrc, "plugin/host.ts"), "utf8")
    expect(host).toContain("hooks.register")
    expect(host).toContain("Hooks.Service")
  })

  test("SQL persists hooks_session_start", () => {
    const sql = fs.readFileSync(path.join(coreSrc, "session/sql.ts"), "utf8")
    expect(sql).toContain("hooks_session_start")
    const migDir = path.join(coreSrc, "database/migration")
    const hits = fs.readdirSync(migDir).filter((name) => fs.readFileSync(path.join(migDir, name), "utf8").includes("hooks_session_start"))
    expect(hits.length).toBeGreaterThan(0)
  })
})
