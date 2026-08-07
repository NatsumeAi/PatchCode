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
