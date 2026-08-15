# Lifecycle Hooks Implementation Plan (W5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `docs/superpowers/specs/2026-08-15-lifecycle-hooks-design.md`: one `Hooks.Service` on live `ToolRegistry.settle`, user/project/plugin handlers, fail-closed PreToolUse/SessionStart, folder trust.

**Architecture:** Discover JSON → validate → **`Trust.Service` (W1)** filter → dispatch. Command/HTTP/Effect handlers. `settleWith` is the only tool fire site. Do not wire V1 `session/tools.ts` as the product. Plugin hooks `Hooks.register` onto this bus.

**Prerequisite:** W1 wrapSpawn + Trust + deny-host, W2 decide already on `bash.ts`. Do not start W5 before that.

**Contract:** the spec. Timeout = deny. No Grok fail-open. TUI lists loaded hooks + last deny in this PR.

---

## Global constraints

```bash
cd packages/core && bun test --timeout 60000 <files>
cd packages/opencode && bun test --timeout 180000 <files>
```

- No `LIVE_CACHE`, no `auth.json`.
- Live deny tests must prove spawn did not run (spy `AppProcess.spawn` or a dummy tool `execute` counter).
- Do not implement hook JS eval.
- Do not commit unless asked.

---

## File map

| Path | Role |
|---|---|
| `packages/core/src/hooks.ts` | namespace |
| `packages/core/src/hooks/schema.ts` | versioned JSON schema |
| `packages/core/src/hooks/trust.ts` | **deleted / not created** — import `Trust` from `packages/core/src/trust.ts` |
| `packages/core/src/hooks/load.ts` | discover + threat scan + compat adapter |
| `packages/core/src/hooks/dispatch.ts` | ordered run + fail-closed |
| `packages/core/src/hooks/run-command.ts` | spawn + stdin JSON + timeout |
| `packages/core/src/hooks/run-http.ts` | POST + `Net.denyHost` |
| `packages/core/src/hooks/service.ts` | Location node |
| `packages/core/src/tool/registry.ts` | Pre/Post/Failure dispatch |
| `packages/core/src/session/execution.ts` | SessionStart gate |
| `packages/core/src/session/input.ts` | UserPromptSubmit |
| `packages/core/src/session/compaction.ts` | Pre/PostCompact |
| `packages/core/src/permission.ts` | PermissionDenied |
| `packages/core/src/session/runner/llm.ts` | Stop |
| task host | SubagentStart/Stop |
| `packages/opencode/src/cli/cmd/` | `trust` command writes `Trust.grant` |
| TUI | loaded hooks + last deny (sidebar or loop-panel section, this PR) |
| `packages/core/test/hooks/*.test.ts` | all proofs |

---

### Task 1: Schema + load (pure)

**Files:** create `schema.ts`, `load.ts`, `test/hooks/load.test.ts`

- [ ] **Step 1: Tests**

- valid v1 file loads one PreToolUse command hook
- unknown top-level key → file error, not loaded
- `scanForThreatsInScope` hit on command string → not loaded
- Claude `PreToolUse` / Cursor `preToolUse` / `beforeShellExecution` map to `PreToolUse`
- matcher empty matches `bash`; matcher `Bash` matches tool `bash`

- [ ] **Step 2: Implement schema + `loadFile(text, origin)` + alias table from spec §5.**

- [ ] **Step 3:** `cd packages/core && bun test --timeout 60000 test/hooks/load.test.ts`

---

### Task 2: Folder trust (reuse W1)

**Files:** import `packages/core/src/trust.ts`. **Do not create** `hooks/trust.ts`. Tests: `test/hooks/trust-import.test.ts` (or reuse `test/trust.test.ts`).

- [ ] **Step 1: Tests**

- empty store → `Trust.isTrusted("/repo")` false
- after `Trust.grant("/repo")` (realpath) → true
- `/repo/sub` true if `/repo` trusted
- `/other` false
- `rg "trusted-folders" packages/core/src/hooks` is empty (only `trust.ts` owns the file)

If W1 `Trust` is missing, **stop** — do not duplicate the store.

- [ ] **Step 2:** `load.ts` calls `Trust.isTrusted(location)` for project specs.

- [ ] **Step 3: Run trust tests.**

---

### Task 3: Command runner fail-closed

**Files:** `run-command.ts`, `test/hooks/run-command-live.test.ts`

- [ ] **Step 1: Live tests** (real `/bin/sh`)

1. `command: "echo '{\"decision\":\"deny\",\"reason\":\"x\"}'"` + PreToolUse → Deny reason x
2. `command: "exit 2"` → Deny
3. `command: "echo '{\"decision\":\"allow\"}'"` → Allow
4. `command: "sleep 10"` timeout 1s → Deny `hook_failed` (not Allow)
5. stdout 100KB → cap 64KB, invalid/partial JSON on PreToolUse → Deny

- [ ] **Step 2: Implement spawn via `AppProcess` (or `child_process` with timeout + killpg). stdin = envelope JSON. Capture 64KB.**

If W1 `wrapSpawn` is missing, **stop this plan** — W5 must not ship unsandboxed project hooks. Wrap project-origin commands as `workspace-child`. Global hooks: no wrap required (operator). Origin is a field on the spec.

- [ ] **Step 3: Run live command tests.**

---

### Task 4: HTTP runner + SSRF

**Files:** `run-http.ts`, `test/hooks/run-http.test.ts`

- [ ] **Step 1: Tests** (mock fetch)

- project hook `http://169.254.169.254/` → Deny/fail at start, no fetch
- project hook `http://127.0.0.1/x` → rejected
- global hook `http://127.0.0.1/x` → allowed to call
- project `https://example.com` 403 → Deny
- body `{"decision":"deny"}` → Deny
- timeout → Deny for PreToolUse

- [ ] **Step 2: Implement URL checks via `Net.denyHost` (do not copy a local 169.254 list).**

- [ ] **Step 3: Run http tests.**

---

### Task 5: `Hooks.Service` + dispatch order

**Files:** `service.ts`, `dispatch.ts`, `hooks.ts`, `test/hooks/dispatch.test.ts`

- [ ] **Step 1: Tests**

- two PreToolUse hooks: first allow, second deny → Deny, first ran
- first deny → second **not** run
- in-process `register` Effect handler can deny
- project specs omitted when untrusted; `untrusted` flag on list()

- [ ] **Step 2: Implement Location node. `load()` at layer init + file watcher optional (not required this plan; load on construct is enough). `register` scoped.**

- [ ] **Step 3: Run dispatch tests.**

---

### Task 6: Wire `ToolRegistry.settle` (the anti-fake task)

**Files:** `packages/core/src/tool/registry.ts`, `test/hooks/settle-pretool.test.ts`

- [ ] **Step 1: Test with a dummy tool whose `execute` increments a counter**

- PreToolUse deny hook loaded globally → settle returns error result; counter **0**
- no hooks → counter 1
- after success → PostToolUse handler ran
- execute throws ToolFailure → PostToolUseFailure ran, not PostToolUse

Use `ApplicationTools` or `Tools.register` in the test Location, plus `Hooks` with an in-process deny register (no files needed for this unit).

- [ ] **Step 2: In `settleWith`, before `settle(registration.tool, …)`:**

```ts
const decision = yield* hooks.dispatch({
  event: "PreToolUse",
  sessionID: input.sessionID,
  toolName: input.call.name,
  toolInput: input.call.input,
})
if (decision._tag === "Deny")
  return { result: { type: "error", value: `Hook denied: ${decision.reason}` } }
```

After success / failure, dispatch Post* (ignore decision).

`Hooks.Service` must be a dep of `ToolRegistry.node`. Tests that compile ToolRegistry without Hooks: provide a no-op layer `Hooks.disabled` that always Allow (for unit tests that do not care). **Production `BuiltInTools` / app graph must use real `Hooks.node`.** `disabled` is test-only; inventory fails if production settle uses `disabled` by default.

- [ ] **Step 3:**

```bash
cd packages/core && bun test --timeout 60000 test/hooks/settle-pretool.test.ts test/session-runner-tool-registry.test.ts
```

Fix any registry tests that need `Hooks.disabled`.

---

### Task 7: SessionStart gate + other fire sites

**Files:** `execution.ts`, `input.ts`, `compaction.ts`, `permission.ts`, `runner/llm.ts`, task host, tests `test/hooks/session-start.test.ts`

- [ ] **Step 1: SessionStart deny → `settle` of any tool on that session fails with `session blocked by SessionStart hook` even if PreToolUse would allow. Persist `session.hooks_session_start` (`pending` \| `allow` \| `deny`) — **not** a process-local `Set`. Reconnect: `allow` does not re-fire; `deny` stays blocked; `pending` fires once.**

- [ ] **Step 2: Add dispatch calls at each spec §4 site. Each site gets a unit test that a registered in-process handler saw the event (use a shared counter in test).**

- [ ] **Step 3: Run `test/hooks/`.**

---

### Task 8: Trust CLI + project hook live

**Files:** `packages/opencode/src/cli/cmd/trust.ts` (or extend existing config cmd), `test/hooks/project-trust-live.test.ts`

- [ ] **Step 1: Live**

- write `<tmp>/.opencode/hooks/deny.json` PreToolUse exit 2
- untrusted Location using that tmp → dummy/bash execute runs
- `Hooks.trust(tmp)` → same hook denies

- [ ] **Step 2: `opencode trust` writes via `Trust.grant` (same file W1 created).**

- [ ] **Step 3: Run project-trust-live.**

---

### Task 9: TUI loaded hooks + last deny

**Files:** TUI sidebar (prefer existing loop-panel or a thin hooks section), HTTP `GET /session/:id/hooks` if needed for the poll.

- [ ] Render `Hooks.list()` ids + last deny reason/event. Untrusted project shows an explicit untrusted line.
- [ ] Test: fixture list with one deny event → panel text contains the hook id and `deny`. “API exists, panel later” is a plan violation.

### Task 10: Inventory

**Files:** `test/hooks/inventory.test.ts`

Fail if:

- `registry.ts` `settleWith` has no `hooks.dispatch` / `PreToolUse` before `settle(`
- `run-command` timeout path returns Allow
- a second trust store under `hooks/trust.ts`
- `trusted-folders` default-true
- V1 `session/tools.ts` is the only PreToolUse (core registry missing)

- [ ] **Step 1:**

```bash
cd packages/core && bun test --timeout 60000 test/hooks/
```

---

## Definition of done

Spec §10 1–11 map to tests. Reviewer: settle deny with counter 0; timeout is deny; untrusted project hook does not run; `read` and a dummy tool both hit the bus; TUI shows last deny.

---

## Out of scope

- Grok `/hooks-trust` UI clone (CLI `opencode trust` + TUI last-deny line is enough; do not skip the TUI list)
- Evaluating hook JS
- Making V1 plugin.trigger the live bus
