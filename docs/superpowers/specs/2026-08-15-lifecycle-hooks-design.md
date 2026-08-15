# Lifecycle Hooks Design (W5)

> **Status:** locked for implementation. Pair with `docs/superpowers/plans/2026-08-15-lifecycle-hooks.md`.
> Final architecture. One bus, one JSON spec, fail-closed on PreToolUse/SessionStart. Not Grok fail-open. Not plugin-only theater.

**Goal:** User/project/plugin hooks on the **live V2 settle path** can block tools. Untrusted repos cannot run project hook code. A hook timeout is a deny, not a silent allow.

**Proven in-tree / refs:**

| Fact | Where |
|---|---|
| Live drain settles tools via `ToolRegistry.settle` | `packages/core/src/session/runner/llm.ts` |
| That path does **not** call `plugin.trigger("tool.execute.before")` | `registry.ts` `settleWith` → `tool.settle` |
| V1 `session/tools.ts` does call plugin before/after | **Dead for HTTP/TUI drain** |
| V2 plugin `ctx.tool.hook("execute.before")` is PLAN.md, not wired | `packages/plugin/src/v2/effect/PLAN.md` |
| Grok events + JSON + matcher + command/http | `xai-grok-hooks` + `10-hooks.md` |
| Grok fail-open on timeout/crash | their docs; **we reject this** |
| OpenCode has no folder-trust store | no `trusted-folders` in core |
| Threat scan exists | `memory/scan.ts` `scanForThreatsInScope` |

---

## 1. Why this is a hole

oh-my-agent already projects into OpenCode. Without a first-class bus on `settle`, they (and we) keep patching V1 plugin hooks that the live runner never sees. That is a fake safety product.

---

## 2. Permanently rejected

| Idea | Why |
|---|---|
| Only revive V1 `plugin.trigger` on `session/tools.ts` | Not the live path. |
| Grok fail-open (timeout = allow) | Unsafe. Timeout/crash/bad JSON = **deny** for blocking events. |
| Silent skip of untrusted project hooks with no event | Operator cannot see they did not load. Skip + durable event. |
| Project hooks trusted by default | Repo can ship `rm -rf ~`. |
| Second bus for MCP / CodeMode / plugin tools | All go through `settle`. |
| Hook command unsandboxed | Forbidden. W5 starts after W1; project command hooks are `workspace-child`. |
| Starlark / JS-eval hooks | Command + HTTP + in-process Effect only. |
| Claude/Cursor files as a second runtime | **Adapters only** into our schema. |

---

## 3. One service

```
Hooks.Service          Location-scoped
  load()               discover + validate + trust-filter
  dispatch(event)      run matching handlers in order
  register(handler)    in-process (plugins); same bus
  list()               loaded specs for TUI/HTTP
```

`dispatch` returns `Allow | Deny{ reason, hookId }`.

Blocking events: **`PreToolUse`, `SessionStart`**.

All others: fire-and-record; failures log + event, do not fail the turn (except we still record). `UserPromptSubmit` is **not** blocking in this program (Grok same).

---

## 4. Events and fire sites (final set)

| Event | Site | Block? |
|---|---|---|
| `SessionStart` | first `wake` while `hooks_session_start=pending`; persist allow/deny on the session row | yes — tools cannot settle until Allow |
| `SessionEnd` | session archive / explicit close | no |
| `UserPromptSubmit` | `SessionInput.admit` of a user prompt | no |
| `PreToolUse` | `ToolRegistry.settle` **before** `tool.settle` | yes |
| `PostToolUse` | after successful settle | no |
| `PostToolUseFailure` | after `ToolFailure` / error settlement | no |
| `PermissionDenied` | `PermissionV2.assert` deny | no |
| `Stop` | runner drain idle / hard abort | no |
| `SubagentStart` / `SubagentStop` | task host spawn / terminal | no |
| `PreCompact` / `PostCompact` | core `session/compaction.ts` | no |

If a site is missed, inventory test fails. Do not add events without a fire site in the same PR.

---

## 5. Spec format (ours)

`~/.opencode/hooks/*.json` and `<project>/.opencode/hooks/*.json`:

```json
{
  "version": 1,
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash|Bash",
        "hooks": [
          { "type": "command", "command": "bin/check.sh", "timeout": 10 }
        ]
      }
    ]
  }
}
```

- Unknown top-level keys → **load fail** (file skipped + error event; global load fail is fatal for that file).
- `matcher`: JS regex on **tool name** (our names: `bash`, `read`, `edit`, …). Empty = all. Aliases: `Bash`→`bash`, `Read`→`read`, `Edit`/`Write`→`edit`/`write`, `Grep`→`grep`, `Glob`→`glob`, `WebSearch`→`websearch`, `Task`→`task`.
- `type`: `command` | `http` only.
- `timeout`: seconds, default 5, max 30.
- Command: relative to the JSON file directory, or a shell string (metacharacters → `/bin/sh -c`).
- HTTP: POST envelope JSON; `deny` if status 403 or body `{"decision":"deny"}`.

**Stdin envelope** (blocking + passive):

```json
{
  "hookEventName": "PreToolUse",
  "sessionId": "ses_…",
  "cwd": "/abs/location",
  "toolName": "bash",
  "toolInput": { "command": "npm test" },
  "timestamp": "2026-08-15T00:00:00.000Z"
}
```

`toolInput` truncated at 128 KiB (`toolInputTruncated: true`).

**PreToolUse stdout:**

- `{"decision":"allow"}` or empty + exit 0 → allow
- `{"decision":"deny","reason":"…"}` or exit 2 → deny
- timeout / signal / exit ≠ 0,2 / invalid JSON → **deny** (`reason: hook_failed`)

---

## 6. Discovery + trust

| Source | Path | Runs when |
|---|---|---|
| Global | `~/.opencode/hooks/*.json` | always |
| Project | `<location>/.opencode/hooks/*.json` | folder trusted |
| Compat | `~/.claude/settings.json`, `settings.local.json`, `~/.cursor/hooks.json` + project counterparts | global always; project if trusted |
| Plugin | `Hooks.register` | plugin scope |

Trust file: **W1** `Trust.Service` / `~/.opencode/trusted-folders.json` — `{ "folders": ["/abs/canonical", ...] }`. Prefix match on `realpath(location)`. No entry → project hooks **not executed**, `hooks.untrusted` event once per Location. Do **not** add `hooks/trust.ts` as a second store.

TUI/CLI: `opencode trust` / existing config command writes that file. This program **adds** `Hooks.trust(path)` + HTTP `POST /session/…` is wrong; use `POST /experimental/trust` or a small `Hooks` HTTP group. Minimum: `Hooks.trust` + config write used by CLI `opencode trust [dir]`.

Compat adapter maps Claude/Cursor event names to ours (Grok table). Unknown vendor events dropped with a warning, file still loads.

---

## 7. Security

1. **Load:** `scanForThreatsInScope(command + file text, "strict")`. Hits → file **not loaded**, event `hooks.threat`.
2. **Project command hooks:** `wrapSpawn("workspace-child")` **always** (W5 starts after W1). `cwd` = Location; no extra env from the repo except `OPENCODE_HOOK_*`.
3. **Project HTTP:** URL must be `https:` and `Net.denyHost` (W1 `packages/core/src/net/deny-host.ts`) rejects loopback / link-local / `169.254.169.254` / metadata DNS. Global HTTP hooks may use http://127.0.0.1 (operator machine).
4. **Fail-closed** on blocking events (above).
5. **No env passthrough of secrets** from the hook JSON (`env: { AWS_SECRET: ... }` rejected at load).
6. Plugin in-process handlers run in-process (trusted like plugins). They return `Allow|Deny`; throw → deny on PreToolUse.

Order: sandbox ∩ exec-policy ∩ **hooks** ∩ permission. PreToolUse runs **after** W2 decide and Permission assert? 

Locked order (same as roadmap §2.1):

```
W2 decide (bash only)
PermissionV2.assert
Hooks.PreToolUse
W1 wrapSpawn + BackgroundJob.start + AppProcess
Hooks.PostToolUse
```

Permission deny → `PermissionDenied` hook, no PreToolUse, no execute.

W2 deny → no PreToolUse (command never “about to run”).

---

## 8. SessionStart gate

`SessionExecution.wake` first time **this session has `hooks_session_start=pending`**: `dispatch(SessionStart)`. Persist the result on the session row (`allow` | `deny`). Deny → further `settle` returns ToolFailure `"session blocked by SessionStart hook"` until an operator clears the flag (new session or explicit reset after hook fix). Reconnect to an `allow` session must **not** re-fire SessionStart. A process-local `Set` is a reconnect hole — forbidden as the only gate.

---

## 9. Observability

Every dispatch: EventV2 `{ event, hookId, source, decision, elapsedMs, reason? }`. `Hooks.list()` for TUI **and** a visible TUI surface (sidebar section or loop-panel) showing loaded hook ids + last deny. HTTP `GET /session/:id/hooks` is not a substitute for the TUI line.

---

## 10. Definition of done (anti-fake)

1. V2 settle of `bash` with a global PreToolUse matcher `bash` that exits 2 → tool error, **no** `AppProcess.spawn` (live or spawn spy).
2. Same hook timeout (sleep > timeout) → deny, no spawn.
3. Project hook in untrusted folder → not run; bash **does** run; `hooks.untrusted` published.
4. After `Hooks.trust(location)`, same project hook **does** deny.
5. `read` tool also hits PreToolUse (not only bash.ts).
6. MCP/dynamic tool name goes through settle → same PreToolUse (unit with a registered dummy tool).
7. SessionStart failing hook → subsequent settle denied; after simulated reconnect (new process, same session id) still denied without re-running the hook.
8. `rg "tool.execute.before" packages/core/src/tool/registry.ts` — hooks dispatch present. V1 `session/tools.ts` is **not** the live bus.
9. Inventory: `settleWith` calls `hooks.dispatch` before `settle(`.
10. Grok fail-open is **not** implemented (`timeout` branch is Deny).
11. TUI or its fixture: loaded hooks list + last deny reason rendered from `Hooks.list()` / last event.

If (1) or (5) only wrap `bash.ts`, W5 is fake.
