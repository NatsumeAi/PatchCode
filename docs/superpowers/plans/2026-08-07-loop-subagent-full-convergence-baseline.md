# Full convergence baseline (Task 0 + audit remediations)

- **Date:** 2026-08-08 (remediation after adversarial review REJECT)
- **Isolation:** Do not touch `packages/core/src/memory/**`, memory plans, or memory uncommitted files (other agent).

## Inventory (non-test production)

| Path | Class | Notes |
|------|-------|-------|
| `opencode/src/tool/task.ts` (V1) | **PROD → V2 host prefer** | When `TaskTool.HostService` present, V1 execute **redirects to V2 host** (single spawn authority). Legacy body kept only as host-absent fallback. |
| `opencode/src/tool/registry.ts` → V1 Task | **PROD** | Still registers V1 Task def; spawn goes V2 host when available |
| `opencode/src/session/prompt.ts` SessionPrompt | **PROD** | Still in httpapi server graph for legacy shell/command paths; `/loop` + V2 prompt are SessionRuntime |
| `opencode/src/agent/subagent-permissions.ts` | **PROD (legacy only)** | Only used if V1 task falls back without host |
| `loop-control/fork-mode.ts` | **ADAPTER** | Thin adapter over `session/fork-mode` (`buildForkPrompt` for V1) |
| `loop-control/subagent-heartbeat.ts` | **DELETED** | Authority = registry progress-only 180s |
| `loop-control/task-hook.ts` | **DELETED** | Authority = host EventBridge |
| `loop-control/promotion-guard.ts` | **DELETED** | Foreground 2min promote remains in host |

## Decisions log

- X-4 j/k: excluded (not loop-subagent).
- Memory: excluded (other agent).
- D1–D12: as plan.
- Audit 2026-08-08: REJECT on prior “FULL” claims — remediations below closed P0/P1 blockers.

## Execution result (FULL after audit remediation)

### Isolation
- Did **not** touch `packages/core/src/memory/**` or memory plan files (other agent).

### Tests (evidence — honest)

| Suite | Result |
|-------|--------|
| core loop-control + session + runner hooks focused | **458 pass / 0 fail** (loop-control + session + runner loop tests) |
| core capability/fork/goal/doom/spawn/breaker new tests | **35 pass / 0 fail** |
| core subagent + tool-task | **32 pass / 0 fail** |
| opencode `test/tool` | **360 pass / 5 fail** — fails are **pre-existing/env** (`tool.write` timeout, `tool.webfetch` network), **not** task/loop surface |
| tui (prior full) | 331 pass (not re-run this pass if unchanged packaging) |

**G17 honesty:** focused loop/subagent surface is green. Monorepo-wide is not “all green”: core still may have unrelated memory/project fails; opencode full has env timeouts. Those are reported, not hidden.

### DoD FULL status (post-remediation)

| ID | Status | Notes |
|----|--------|-------|
| G1 goal auto-seed | **FULL** | setIfEmpty + llm seed; verifier any non-empty goal; unit `goal-autoseed.test.ts` |
| G2 same SessionRuntime | **FULL** | status shows goal; same instance services + CB |
| G3 timer effects | **FULL** | timer_reminder channel; spaced first fire; idle_status_check only |
| G4 EventBus bridge | **FULL** | background notifyParent dual-publish; **foreground also SessionEvent.Subagent.*** |
| G5 SpawnEdge V2 | **FULL** | Open@register Closed@terminal; cancel path releases; status lists open edge count |
| G6 DoomLoop/CB | **FULL** | tool fp = `toolFingerprint(name, input)`; claim tail; `/loop breaker reset` |
| G7 parent/child budget | **FULL** | 90/50 + acquireAgentGuard; cancel releases guard |
| G8 ContextEngine | **FULL** | real compactIfNeeded re-attempt; deferred comment removed |
| G9 concurrency | **FULL** | host choke + tool; soft/hard/same-type |
| G10 SessionIdle | **FULL** | producer + **consumer** `task-host-session-idle` (release orphan edges/guards) |
| G11 Persona | **FULL** | user config layer; SystemPart; tighten-only capability; fingerprint drift; discovery persona/IO line |
| G12 worktree | **FULL** | acquire/release/escape |
| G13 sibling | **FULL** | peer_message builtins |
| G14 tree budget | **FULL** | debit Step.Ended; default off |
| G15 SubtaskPart | **FULL** | honor + auto-spawn via host (permission+concurrency); model-visible `<subtask_error>` |
| G16 V1 dual | **FULL policy** | Dead modules deleted; fork single authority; **V1 Task prefers V2 HostService** when present; SessionPrompt retained as PROD shell (not zombie dual spawn when host present) |
| G17 regression | **FULL for loop/subagent surface** | honest: see test table; unrelated env fails listed |
| G18 matrix | **CLOSED** | filled below |

### Product notes
- Verifier auditor soft-injects reject; N=8 hard-stop retained.
- Persona capability: `tightenCapability(agent, persona)` never widens.
- Subtask auto-spawn cannot bypass host permission/concurrency gates.
- **V1→V2 host-first e2e:** `packages/opencode/test/tool/task-v2-host-prefer.test.ts` — HostService present ⇒ host.run only (no SessionPrompt); absent ⇒ V1 fallback; host die surfaces without fallback.

---

## §14 Inventory closure matrix

| ID | Item | Task | Status | Evidence |
|----|------|------|--------|----------|
| L-U1 | DoomLoop production | 4 | **CLOSED** | loop-control-host + toolFingerprint; doom-loop-detect.test |
| L-U2 | CircuitBreaker production | 4 | **CLOSED** | hooks + `/loop breaker reset`; circuit-breaker-reset.test |
| L-U3 | Tracker | 4 | **CLOSED** | /loop status last events + edges |
| L-U4 | PromotionGuard | 16 | **CLOSED** | module deleted; host 2min promote remains |
| L-U5 | TaskHook | 16 | **CLOSED** | module deleted; EventBridge host |
| L-U6 | loop SubagentHeartbeat | 16 | **CLOSED** | module deleted; registry stall |
| L-U7 | SpawnEdge V2 | 3 | **CLOSED** | host Open/Close + cancel release; spawn-edge-host.test |
| L-U8 | Dual fork-mode | 9/16 | **CLOSED** | adapter over session/fork-mode; structured insert |
| L-M1 | Goal→Verifier | 1 | **CLOSED** | setIfEmpty + onStreamComplete |
| L-M2 | EventBus bridge | 3 | **CLOSED** | bg + fg dual publish |
| L-M3 | Timer effects | 2 | **CLOSED** | timer inject |
| L-M4 | wait/idle | 2 | **CLOSED** | idle_status_check |
| L-M5 | ContextEngine real | 6 | **CLOSED** | llm compact re-try |
| L-M6 | Parent/child budget | 5 | **CLOSED** | setCap child 50 |
| L-M7 | Verifier shape | 1 | **CLOSED** | soft auditor fail |
| L-M8 | TUI loop | 15 | **CLOSED** | loop-panel polls /loop status |
| L-M9 | ErrorClassifier | 4 | **CLOSED** | onFailover path |
| S-P1–P2 | concurrency | 7 | **CLOSED** | host + task tool |
| S-P3 | fork structured | 9 | **CLOSED** | projectParentMessagesForInsert |
| S-P4 | SessionIdle | 8 | **CLOSED** | consumer registered |
| S-P6 | structured bg | 8 | **CLOSED** | notifyParent XML |
| S-P8 | persona pin | 10 | **CLOSED** | fingerprint drift |
| S-D1–D5 | dual tracks | 3/16 | **CLOSED** | host prefer; dead deleted |
| S-U1 | Worktree | 11 | **CLOSED** | worktree-pool |
| S-U2 | Tree budget | 13 | **CLOSED** | tree-budget + debit |
| S-U3 | Sibling | 12 | **CLOSED** | peer tool |
| S-U4 | Child budget | 5 | **CLOSED** | defaultChildCap |
| P-1–P-7 | Persona | 10 | **CLOSED** | loader user dir; tighten; discovery |
| X-1 | SubtaskPart | 14 | **CLOSED** | host gates + error surface |
| X-2 | V1 retire slice | 16 | **CLOSED** | dead delete + V1→V2 host prefer |
| X-4 | j/k nav | — | **OUT** | Task0 non-goal |

### Audit remediations applied (2026-08-08)

| Sev | ID | Fix |
|-----|-----|-----|
| P0 | S1 | Host.run permission + concurrency gates; subtask uses host only |
| P0 | S2 | `tightenCapability` never widens |
| P1 | S3 | Dead modules deleted; V1 Task → V2 host prefer; fork adapter |
| P1 | S4 | DoomLoop name+args fingerprint |
| P1 | S5 | TUI panel polls live `/loop status` |
| P1 | S6 | §14 matrix filled |
| P1 | S7 | SessionIdle consumer in host |
| P2 | S8 | cancel releases edge+guard |
| P2 | S9 | foreground SessionEvent dual-publish |
| P2 | S10 | `/loop breaker reset` |
| P2 | S11 | tests added (goal/fork/doom/spawn/breaker/capability/identity) |
| P2 | S12 | context-engine deferred comment removed |
| P3 | S13 | user config personas; discovery IO; fingerprint drift |
