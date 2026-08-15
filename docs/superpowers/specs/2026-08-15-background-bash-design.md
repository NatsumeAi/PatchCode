# Background Bash Design (W3)

> **Status:** locked for implementation. Pair with `docs/superpowers/plans/2026-08-15-background-bash.md`.
> Final architecture. One job ledger (`BackgroundJob`). No second bash runtime, no reattach-after-crash fairy tale, no cron/`monitor` product in this program.

**Goal:** Model-facing background shell: launch returns an owner-bound id; get / wait / kill work; completion is admitted back into the parent session; crash recovery **kills leftovers** and marks `lost` — it does not pretend to resume pipes.

**Proven on this host (2026-08-15):**

```
Popen(sleep 30, start_new_session=True)  → pid == pgid
killpg(pid, SIGKILL) + wait              → poll_rc -9, kill(pid,0) → ProcessLookupError
```

`BackgroundJob` already exists (`packages/core/src/background-job.ts` + SQL). Task host uses it for **subagents**. Bash does not. `cancel` closes the Effect scope; `AppProcess` `acquireRelease` already SIGTERM→SIGKILL the process group. That is the kill path. Do not invent a second killer.

---

## 1. Threat / fake-product model

Today `bash.ts` TODOs refuse to expose background because:

- no restart story
- no owner-bound get/wait/cancel
- no HTTP auth

A fake W3 would be: return a uuid, keep the process only in a closure, lose it on restart, still tell the model “running”. Or: persist status `running` forever with no pid, cannot kill.

This design makes those states impossible to green with mocks.

---

## 2. Permanently rejected

| Idea | Why |
|---|---|
| Re-attach stdout to a leftover PID after process restart | Not executable. Pipes die with the server. |
| Detached orphans that we “adopt” | Fake. We **kill** leftovers on boot. |
| Second job service (`BashJob`) | Parallel to `BackgroundJob`. Forbidden. |
| Codex `unified_exec` PTY as a second background | Different product. PTY stays interactive. |
| Grok `monitor` + durable `/loop` cron | Out of W3. Get/wait is enough to poll output. |
| Background bash bypassing W1 wrap / W2 decide | Fake safety. Same gates as foreground. |
| `detached: true` without pid/pgid in the ledger | Crash leaves unkillable orphans. |

---

## 3. One object

Every bash invocation is a `BackgroundJob` row:

| Field | Value |
|---|---|
| `type` | `"bash"` |
| `metadata.sessionId` | launching session |
| `metadata.callID` | tool call id |
| `metadata.pid` / `metadata.pgid` | set as soon as spawn returns (required for running) |
| `metadata.command` | original command (for display / leftover cmdline check) |
| `status` | `running` \| `completed` \| `error` \| `cancelled` |
| `error` | `lost-after-crash` when reaped |

Foreground: `start` + `wait` (same as today from the model’s point of view).

Background: `start`, return `{ jobID, status: "running" }` immediately.

Promote (TUI / HTTP “send to background”): `wait` stops; job keeps running. Uses existing `promote()`.

Do **not** start a second process when promoting.

---

## 4. Process lifetime (honest)

```
decide (W2) → wrapSpawn (W1) → AppProcess.spawn (scoped)
     ↓
BackgroundJob.start({ type: "bash", run: scoped spawn })
     ↓
cancel / session interrupt / server finalizer
     → Scope.close → existing acquireRelease killpg SIGTERM + SIGKILL
```

- Record `pid`/`pgid` in metadata **before** returning start to the caller.
- Do not `unref` without keeping the job in `liveJobIds`.
- Prefer **not** using `detached: true` for bash jobs so a hard kill of the server process group tends to take children. If Effect/spawner still defaults detached on POSIX, that is OK **only if** pid/pgid are stored and boot reap killpg’s them.

**Boot reap (extend existing `reapStale`):**

For leftover `type=bash` `status=running` not in `liveJobIds`:

1. If `metadata.pgid` or `pid` present: `killpg` SIGKILL, wait/reap (best-effort).
2. Set `status=error`, `error=lost-after-crash`.
3. Do **not** copy leftover `/proc` stdout into `output`.
4. Notify parent session the same way as a failed job (admit + wake).

Never resume a bash job across process starts.

---

## 5. Model tools

**`bash`**

```
command, workdir?, timeout?, background?: boolean
```

- `background !== true`: wait; return exit/output as today.
- `background === true`: return immediately:

```
jobID, status: "running"
output: "Started in the background. Use the job tool with this jobID. You will also be notified when it finishes."
```

Same `MAX_TIMEOUT_MS` (10 min) applies to background. No second timeout constant.

**`job`** (new builtin, one tool)

```
action: "get" | "wait" | "kill"
id: string
timeout?: number   // wait only
```

- Owner-bound: `metadata.sessionId === caller session` (or caller is the parent session if we later nest; bash is always the launching session).
- Wrong owner → `Job.Forbidden` (not found-shaped 404 that leaks existence to other sessions? Prefer **not found** to avoid id scan).
- `get`: snapshot + tail of output (bounded, same `ToolOutputStore` / job.output).
- `wait`: existing `BackgroundJob.wait`.
- `kill`: existing `BackgroundJob.cancel` (scope kill).

Cap: **8** running `type=bash` jobs per session. Ninth `background: true` fails with `Job.Busy`.

---

## 6. Output and completion

- While running: reuse bash progress events (32 KiB tail). Also append into job.output (truncate to `ToolOutputStore.MAX_BYTES`).
- On settle: persist output on the row; `ToolOutputStore.bound` for the original callID if still needed.
- On complete/error/cancel/lost: admit a short **synthetic** message on the parent session (`<job-result jobID=… status=…>…</job-result>`) with **`resume: false`**, then `SessionExecution.wake` only if the session is not hard-aborted. Do **not** call `SessionV2.prompt({ resume: true })` / omit resume — that path `terminal.reset`s and would restart a `/loop abort`ed drain.
- Test (required): session with live drain, `/loop abort`, then a background bash job completes → terminal stays `user_abort`; no new model turn from the job message.
- If the parent is mid-drain (not aborted), admission follows existing inbox rules (queued until a safe boundary).

---

## 7. HTTP (session-scoped, not experimental-flag)

Same `BackgroundJob` service:

| Method | Path | Rule |
|---|---|---|
| GET | `/session/:id/jobs` | list `sessionId === id` |
| GET | `/session/:id/jobs/:jobID` | get if owner |
| POST | `/session/:id/jobs/:jobID/wait` | wait |
| POST | `/session/:id/jobs/:jobID/kill` | cancel |
| POST | `/session/:id/jobs/:jobID/promote` | promote (TUI must **not** use Ctrl+G) |

No passwordless list of all jobs. Wrong session → 404.

---

## 8. TUI

`ctrl+g` is already `messages_first` (and a leader). **Do not rebind it.**

Promote a running **foreground** bash via HTTP `POST .../promote` (existing `BackgroundJob.promote`: stop waiting, same pid). TUI: add `job_promote` bound to an unused chord after grepping `keybind.ts` (`ctrl+b` is already `session_background` + `input_move_left`). Slash `/job promote` is acceptable if no free chord. Same id the model would have gotten had `background: true` been set. No second process.

---

## 9. Composition

```
W2 decide → W1 wrapSpawn → job.start(spawn)
job.kill  → scope close → wrap-spawned child dies
```

W1+W2 **must** already be on `packages/core/src/tool/bash.ts`. W3 only inserts `BackgroundJob.start` at that spawn site. Do not create `background-bash.ts`. Do not start a job if decide/permission/PreToolUse denied.

---

## 10. Definition of done (anti-fake)

Live tests, real `sleep` / `AppProcess`, real SQL:

1. `background: true` returns `jobID` in < 200ms while `sleep 5` still runs (`kill(pid,0)` true).
2. `job wait` after sleep → `completed`, output captured, pid dead.
3. `job kill` on `sleep 30` → `cancelled`, pid dead after wait.
4. Process restart simulation: insert running bash row with live leftover pid → `BackgroundJob.make` (reap) → pid dead, row `error=lost-after-crash`, **output not invented**.
5. Other session’s `job get` → not found; spawn never cancelled.
6. 9th concurrent background bash on one session → `Job.Busy`; 8 running.
7. `bash` with `background: true` still runs W2 deny (`rm -rf /`) **without** creating a running job.
8. Inventory: `packages/core/src/tool/bash.ts` contains `BackgroundJob` `start`; no new `BashJob` type.

If (1) or (4) are implemented by mocking `AppProcess` or skipping killpg, W3 is not done.
