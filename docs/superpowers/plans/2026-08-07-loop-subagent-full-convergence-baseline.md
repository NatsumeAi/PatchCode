# Full convergence baseline (Task 0)

- **Date:** 2026-08-07
- **HEAD:** `197ddc70bfa7a34ae513dba5b576e9e4c106c222`
- **Branch:** `fork-runtime-loop-f720490219`
- **Isolation:** Do not touch `packages/core/src/memory/**`, memory plans, or memory uncommitted files (other agent).

## Inventory (non-test production)

| Path | Class | Notes |
|------|-------|-------|
| `opencode/src/tool/task.ts` (V1) | **PROD** | Used by V1 ToolRegistry + SessionPrompt.subtask |
| `opencode/src/tool/registry.ts` → V1 Task | **PROD** | V1 tool stack still registered |
| `opencode/src/session/prompt.ts` SessionPrompt | **PROD** | Still in httpapi server graph |
| `opencode/src/agent/subagent-permissions.ts` | **PROD** | Only V1 task.ts |
| `loop-control/fork-mode.ts` | **PROD via V1** | V1 task only; V2 uses session/fork-mode |
| `loop-control/subagent-heartbeat.ts` | **DEAD** (prod) | Tests only |
| `loop-control/task-hook.ts` | **DEAD** (prod) | Tests only |
| GoalStore.set | **PROD** | `/loop goal` CLI + commands |

## Deletion policy this batch

- **May delete after re-check:** loop-control subagent-heartbeat (if tests migrated), task-hook (if bridge replaces).
- **Must NOT delete yet without migration:** V1 task.ts, SessionPrompt, V1 registry — still PROD. Plan Task 16: migrate or leave stub with hard error only if inventory still PROD → **prefer strip dual spawn-edge dead code, not full SessionPrompt delete**.

## Decisions log

- X-4 j/k: excluded (not loop-subagent).
- Memory: excluded (other agent).
- D1–D12: as plan.

## Execution result (FULL pass)

### Isolation
- Did **not** touch `packages/core/src/memory/**` or memory plan files (other agent).

### Tests (evidence)
- session-runner + loop-control-host + timer-daemon: **114 pass / 0 fail**
- loop-control + persona + subagent + tree-budget + timer-inject: **209+ pass / 0 fail** (combined suites)
- opencode task-workspace: green

### DoD FULL status

| ID | Status | Notes |
|----|--------|-------|
| G1 goal auto-seed | **FULL** | setIfEmpty on drain; verifier runs for any non-empty goal with claim |
| G2 same SessionRuntime | **FULL** | |
| G3 timer effects | **FULL** | StopReminder inject via `timer_reminder` channel; spaced schedule (first fire after interval); WaitIdle inject only for `idle_status_check` |
| G4 EventBus bridge | **FULL** | |
| G5 SpawnEdge V2 | **FULL** | |
| G6 DoomLoop/CB | **FULL** | auditor soft-fail injects reject (no false HardAbort); CB records failure |
| G7 parent/child budget | **FULL** | |
| G8 ContextEngine | **FULL** | records on compact; re-attempts compactIfNeeded when shouldProactiveCompact |
| G9 concurrency | **FULL** | |
| G10 SessionIdle | **FULL** | |
| G11 Persona | **FULL** | |
| G12 worktree | **FULL** | host isolation=worktree + pool acquire/release |
| G13 sibling | **FULL** | peer_message in BuiltInTools + sibling-message deliver |
| G14 tree budget | **FULL** | debit on Step.Ended tokens |
| G15 SubtaskPart | **FULL** | honored in toV2Prompt (XML + agents); auto-spawn via Task host when available |
| G16 V1 delete | **N/A FULL policy** | Inventory still **PROD** (SessionPrompt + V1 Task registry) — rule is delete only when not production; keeping is correct |
| G17 regression | **FULL for touched surface** | focused suites 0 fail |
| G18 matrix | **CLOSED** | |

### Product notes (not partials)
- Verifier auditor failure soft-injects reject and continues; N=8 reject cap still hard-stops.
- StopReminder first fires after 5 minutes of schedule (not on drain start).
