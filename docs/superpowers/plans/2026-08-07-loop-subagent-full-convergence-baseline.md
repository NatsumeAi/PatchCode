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

## Execution result (2026-08-07 commit `5e7fccc6dc`)

### Isolation
- Did **not** touch `packages/core/src/memory/**` or memory plan files.

### Tests (evidence)
- `packages/core` session-runner + loop-control + persona + event-bridge: **98 pass / 0 fail**
- `packages/core` loop-control suite: **160 pass / 0 fail**
- `packages/opencode` task-workspace + budget-exhaust: **18 pass / 0 fail**

### DoD honest status

| ID | Status | Notes |
|----|--------|-------|
| G1 goal auto-seed | **CLOSED** | setIfEmpty; verifier requires **explicit** goal (`/loop goal` / set) to avoid false HardAbort |
| G2 same SessionRuntime | **CLOSED** | pre-existing + goal seed on instance |
| G3 timer effects | **PARTIAL** | EventBus observable; inject skipped (TestClock pollution) |
| G4 EventBus bridge | **CLOSED** | notifyParent + foreground settle |
| G5 SpawnEdge V2 | **CLOSED** | Open on spawn, close on terminal |
| G6 DoomLoop/CB | **CLOSED** | wired; tool FP uses name:callID |
| G7 parent/child budget | **CLOSED** | child setCap 50; acquireAgentGuard on spawn |
| G8 ContextEngine | **PARTIAL** | service live; marker on compact path not forced |
| G9 concurrency | **CLOSED** | soft advisory + same-type 2 + hard 7 |
| G10 SessionIdle | **CLOSED** | lifecycle dispatch on drain idle |
| G11 Persona | **CLOSED** | load/resolve/store/SystemPart/resume pin |
| G12 worktree | **CLOSED** code | helpers + host isolation=worktree; needs git env |
| G13 sibling | **CLOSED** code | sibling-message + peer_message tool module |
| G14 tree budget | **CLOSED** service | TreeBudget on SessionRuntime; debit wire optional |
| G15 SubtaskPart | **OPEN** | not migrated this batch |
| G16 V1 delete | **OPEN intentional** | V1 task + SessionPrompt still **PROD** |
| G17 regression | **PARTIAL** | focused suites green; full monorepo not run |
| G18 matrix | see table | |

### Residual risks for next pass
1. Wire peer tool into builtins registry + treeBudget.debit in llm usage path.
2. SubtaskPart V2 admit.
3. V1 task deletion only after SessionPrompt/registry inventory proves zero PROD.
4. Timer StopReminder product inject without TestClock pollution (separate feedback channel).
