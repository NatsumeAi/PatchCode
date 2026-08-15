# Background Bash Implementation Plan (W3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the locked W3 design in `docs/superpowers/specs/2026-08-15-background-bash-design.md`: every live V2 bash is a `BackgroundJob`; background launch / get / wait / kill / crash-kill leftovers are real OS behaviors.

**Architecture:** Reuse `BackgroundJob` (no second ledger). `bash` `run` is a scoped `AppProcess.spawn` so `cancel` → existing acquireRelease killpg. Boot `reapStale` killpg leftover pids. New `job` builtin + session HTTP. Completion via `SessionInput.admit` + `SessionExecution.wake`.

**Tech Stack:** TypeScript, Effect, Bun test, existing SQLite `background_job` table, `AppProcess`.

**Contract:** the spec. Do not add `monitor`, cron, or PID reattach.

---

## Global constraints

```bash
cd packages/core && bun test --timeout 60000 <files>
cd packages/opencode && bun test --timeout 180000 <files>
```

- No `LIVE_CACHE`, no `auth.json`.
- Live process tests **must not** mock `AppProcess`. Mocking spawn in a test named `live` / `kill` / `reap` is a plan violation.
- Do not add `BashJob` / `ShellJob` services.
- Do not change subagent `type: "task"` job semantics except shared reap (bash leftovers get killpg; task leftovers stay “stale-after-crash” without pid kill).
- W1/W2 **must already be on this `bash.ts` execute.** Call decide → wrapSpawn → `BackgroundJob.start`. If they are not merged, stop — do not ship W3 with a second spawn recipe.
- Job completion must not call `SessionV2.prompt` with `resume !== false`.
- Do not bind Ctrl+G (already `messages_first`).
- Do not commit unless the user asks.

---

## File map

| Path | Role |
|---|---|
| `packages/core/src/background-job.ts` | reap killpg for `type=bash`; expose nothing new unless needed |
| `packages/core/src/tool/bash.ts` | always `start`; wait unless `background` |
| `packages/core/src/tool/job.ts` | `get` / `wait` / `kill` |
| `packages/core/src/tool/builtins.ts` | register `job` |
| `packages/core/src/session/job-complete.ts` | admit + wake helper (**synthetic, `resume: false`**) |
| `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` | job routes |
| `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` | owner checks |
| TUI keybind | **not** Ctrl+G. Add `job_promote` after grepping `packages/tui/src/config/keybind.ts` for a free chord (e.g. unused `ctrl+shift+j`). HTTP promote is the product. |
| `packages/core/test/background-bash/killpg-live.test.ts` | OS probe |
| `packages/core/test/background-bash/bash-job-live.test.ts` | launch/wait/kill |
| `packages/core/test/background-bash/reap-lost-live.test.ts` | leftover pid dies |
| `packages/core/test/background-bash/owner.test.ts` | cross-session deny |
| `packages/opencode/test/background-bash/http-owner.test.ts` | 404 other session |

---

## §0 Locked OS fact

```
start_new_session sleep 30 → pid == pgid
killpg(SIGKILL) + wait     → process gone
```

`kill(pid, 0)` **before wait** can still succeed (zombie). Tests must `wait`/`poll` after kill.

---

### Task 1: Live killpg probe (gate)

**Files:**
- Create: `packages/core/test/background-bash/killpg-live.test.ts`

No product code. If this fails, stop.

- [ ] **Step 1: Write**

```ts
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"

describe.skipIf(process.platform === "win32")("killpg leftover", () => {
  test("killpg + wait reaps a new-session sleep", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
    const pid = child.pid
    expect(pid).toBeGreaterThan(0)
    await Bun.sleep(50)
    process.kill(-pid!, "SIGKILL")
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", (c) => resolve(c))
      setTimeout(() => resolve(child.exitCode), 2000)
    })
    expect(code === null || code !== 0).toBe(true)
    expect(() => process.kill(pid!, 0)).toThrow()
  })
})
```

- [ ] **Step 2:**

```bash
cd packages/core && bun test --timeout 60000 test/background-bash/killpg-live.test.ts
```

Expected: pass on this Linux host.

---

### Task 2: Reap leftover bash pids

**Files:**
- Modify: `packages/core/src/background-job.ts` `reapStale`
- Create: `packages/core/test/background-bash/reap-lost-live.test.ts`

- [ ] **Step 1: Failing live test**

```ts
// spawn detached sleep
// insert BackgroundJobTable row type=bash status=running metadata={ pid, pgid: pid, sessionId, command: "sleep 30" }
// yield* BackgroundJob.make  // constructs and reaps
// expect process.kill(pid,0) throws
// expect row.status === "error" && row.error === "lost-after-crash"
// expect row.output is null/empty (not invented)
```

Use the same DB fixture pattern as `packages/core/test/background-job.test.ts` (`Database.layerFromPath`).

- [ ] **Step 2: Implement reap**

After selecting leftover `running` rows not in `liveJobIds`:

```ts
if (row.type === "bash") {
  const pid = Number(row.metadata?.pgid ?? row.metadata?.pid)
  if (Number.isFinite(pid) && pid > 1) {
    yield* Effect.sync(() => {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
    })
  }
}
// then existing update status=error error="lost-after-crash"
```

Do **not** kill leftover `type=task` pids (they are sessions, not shell pgids).

- [ ] **Step 3:**

```bash
cd packages/core && bun test --timeout 60000 test/background-job.test.ts test/background-bash/reap-lost-live.test.ts
```

Existing crash tests must still pass (`stale-after-crash` / `lost-after-crash` — use `lost-after-crash` for bash only; keep `stale-after-crash` for task rows).

---

### Task 3: Every bash is a job (foreground still waits)

**Files:**
- Modify: `packages/core/src/tool/bash.ts`
- Modify: bash layer deps → `BackgroundJob.node`
- Modify: `packages/core/test/tool-bash.test.ts` mock `BackgroundJob` **or** provide real `BackgroundJob` + mocked `AppProcess`

- [ ] **Step 1: Refactor execute**

```ts
const job = yield* jobs.start({
  type: "bash",
  title: input.command.slice(0, 80),
  metadata: {
    sessionId: context.sessionID,
    callID: context.toolCallID,
    command: input.command,
  },
  run: /* existing collect/spawn Effect, returning output string */,
})
// After spawn handle exists, patch metadata.pid / pgid onto the job
// (add BackgroundJob.touchMetadata if no API — one method, do not fork a new service)

if (input.background === true) {
  return { jobID: job.id, output: "...", /* structured running */ }
}
const waited = yield* jobs.wait({ id: job.id, timeout: input.timeout ?? DEFAULT_TIMEOUT_MS })
// map waited.info to existing Output
```

Foreground tests in `tool-bash.test.ts` must stay green. Mock `BackgroundJob.start` so it runs `input.run` inline if that is simpler for unit tests; live file (Task 4) uses real start.

If `start` cannot set pid until spawn, add:

```ts
readonly patch: (id: string, metadata: Record<string, unknown>) => Effect.Effect<void>
```

on `BackgroundJob.Interface`. One method.

- [ ] **Step 2: Run `test/tool-bash.test.ts` — expect PASS.**

---

### Task 4: Live background launch / wait / kill

**Files:**
- Create: `packages/core/test/background-bash/bash-job-live.test.ts`
- Modify: `packages/core/src/tool/bash.ts` Input schema add `background`

- [ ] **Step 1: Live tests** (real AppProcess + real BackgroundJob + real bash tool settle)

1. `background: true`, `command: "sleep 5"` → settle returns in < 200ms; `jobs.get` status running; `process.kill(pid, 0)` ok.
2. Then `jobs.wait({ id, timeout: 10_000 })` → completed; pid dead.
3. `background: true`, `sleep 30`; `jobs.cancel(id)` → cancelled; after wait pid dead.
4. Foreground `echo hello` still returns output `hello` (no background).

Need pid from `jobs.get(id).metadata.pid`. Task 3 must have written it.

- [ ] **Step 2: Implement `background` input + early return.**

- [ ] **Step 3:**

```bash
cd packages/core && bun test --timeout 60000 test/background-bash/bash-job-live.test.ts test/tool-bash.test.ts
```

---

### Task 5: `job` tool + owner + cap 8

**Files:**
- Create: `packages/core/src/tool/job.ts`
- Modify: `packages/core/src/tool/builtins.ts`
- Create: `packages/core/test/background-bash/owner.test.ts`
- Create: `packages/core/test/background-bash/cap.test.ts`

- [ ] **Step 1: Tests**

- get/wait/kill only when `metadata.sessionId === context.sessionID`
- other session → ToolFailure not-found
- 8 running bash jobs: 9th `background: true` fails `Job.Busy` (count `type===bash && status===running && sessionId`)

- [ ] **Step 2: Implement `job` tool + cap in `bash.ts` before `start`.**

- [ ] **Step 3: Run owner + cap + bash-job-live.**

---

### Task 6: Completion admit + wake

**Files:**
- Create: `packages/core/src/session/job-complete.ts`
- Modify: bash `run` settle path and reap notify
- Create: `packages/core/test/background-bash/complete-admit.test.ts`

- [ ] **Step 1: Test**

When a bash job completes, `SessionInput` has a new admitted **synthetic** entry containing `jobID` and status; `resume: false` (or equivalent flag that does **not** call `terminal.reset`). `SessionExecution.wake` was called **only if** the session is not `user_abort`.

Additional live test: abort the session-owned drain, complete a background `sleep 0.2`, assert loop terminal still `user_abort`.

Message text:

```
<job-result jobID="job_…" status="completed" exit="0">
…bounded output…
</job-result>
```

- [ ] **Step 2: Implement `notifyJobFinished(sessionID, info)` and call it from bash run’s end **and** from bash reap (lost).**

Do not notify for `type=task` here (already has Subagent events).

- [ ] **Step 3: Run complete-admit test.**

---

### Task 7: HTTP owner routes

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- Create: `packages/opencode/test/background-bash/http-owner.test.ts`

Follow existing session handler auth. Endpoints per spec §7.

- [ ] **Step 1: Test list/get/kill: job of session A is 404 when requested under session B.**

- [ ] **Step 2: Implement.**

- [ ] **Step 3: Run http-owner test from `packages/opencode`.**

---

### Task 8: TUI / HTTP promote (not Ctrl+G)

**Files:**
- TUI keybind module `packages/tui/src/config/keybind.ts` — add `job_promote` on an **unused** chord. **Forbidden:** `ctrl+g` (`messages_first`), `ctrl+b` (`session_background` / `input_move_left`).
- HTTP already in Task 7.

- [ ] **Step 1: Unit test the binding (or slash) calls promote, not cancel. Assert `keybind.ts` `messages_first` still contains `ctrl+g`.**

- [ ] **Step 2: Implement using existing `BackgroundJob.promote`.**

- [ ] **Step 3: Handler test that promote leaves pid alive (live, next to bash-job-live).**

---

### Task 9: W2 deny does not start a job + inventory

**Files:**
- Create: `packages/core/test/background-bash/inventory.test.ts`
- If W2 `ExecPolicy` exists: test `background: true` + `rm -rf /` → no `type=bash` running row. **Required**, not optional — W2 is a W3 prerequisite.

- [ ] **Step 1: Inventory fails if**

- `packages/core/src/tool/bash.ts` lacks `BackgroundJob` / `jobs.start`
- a new `BashJob` / `ShellJob` export exists
- `background: true` path skips `permission` / exec-policy (string `start(` appears before `assert` / `decide` in the file)

- [ ] **Step 2:**

```bash
cd packages/core && bun test --timeout 60000 test/background-bash/ test/background-job.test.ts test/tool-bash.test.ts
cd packages/opencode && bun test --timeout 180000 test/background-bash/
```

---

## Definition of done

Spec §10 items 1–8 each map to a test name. Reviewer runs Task 1 and Task 4 on this host and sees a live `sleep` pid appear and die. Reap test kills a leftover pid. No `BashJob` type.

---

## Out of scope

- `monitor` tool / line-notify product
- Durable cron / `/loop` interval prompts
- Reattach after restart
- Windows job objects (win32 live tests skip; cancel uses existing `taskkill` path in spawner)
- Changing subagent job type semantics
