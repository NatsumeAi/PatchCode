# Loop + Subagent Full Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This is ONE plan.** Do not split into Plan 1/2/3 documents. All phases below are ordered tasks of the same delivery. The batch is **not done** until §0 DoD Gate and §14 Inventory Closure both pass green.

**Goal:** In a single execution batch, fully close every open Loop-control, Subagent-runtime, Persona, dual-path, and dead-V1 gap so the product has one mature harness loop, one subagent host path, one identity layer (persona), and zero half-wired dual tracks — without regressing already-shipped V2 behavior.

**Architecture:** Keep the live V2 spine (`SessionV2` → `SessionRunner.llm` → `SessionRuntime` + `LoopControlHost.makeSessionHooks` → `core TaskTool` → `tool-host-bridges` → `SubagentRegistry`). Complete missing edges (goal→verifier, subagent→EventBus, SpawnEdge, DoomLoop/CircuitBreaker, ContextEngine→real compact, persona SystemPart, soft concurrency, SessionIdle, fork structured option, parent/child budgets). Delete confirmed-dead V1 dual implementations after an inventory gate. Single authority per concern (table §0.2).

**Tech Stack:** Effect-TS / Effect Schema, `@opencode-ai/core` + `@opencode-ai/opencode` + `@opencode-ai/schema` + TUI, Bun test. Reference implementations under `/home/huyongjun/reference/` (grok-build, hermes-agent, codex) for persona prompt shape, iteration budget, spawn edge, worktree.

**Related docs (read-only inputs, not parallel plans):**
- `docs/loop-design.md`
- `docs/superpowers/plans/2026-08-03-subagent-runtime-overhaul.md` (already largely implemented)
- `docs/superpowers/specs/2026-08-07-subagent-persona.md` (**accepted by this plan**)
- `docs/superpowers/specs/2026-08-07-dual-path-classification.md`
- Prior gap inventory from session analysis (IDs L-*, S-*, P-*, X-*)

**Reference sources (copy patterns, not files):**
| Concern | Reference |
|---------|-----------|
| Persona / role system injection | `reference/grok-build-main/crates/codegen/xai-grok-agent/templates/subagent_prompt.md` (`<persona>`, `<role-instructions>`) |
| Persona as named identity | `reference/grok-build-main/prod/mc/cli-chat-proxy-types/src/subagent_bundle.rs` |
| Parent/child iteration caps | `reference/hermes-agent/agent/iteration_budget.py` (parent 90 / subagent 50) |
| Error classes / retry | `reference/hermes-agent/agent/error_classifier.py` |
| Spawn edge Open/Closed | `reference/codex/codex-rs/.../ThreadSpawnEdge` / `0021_thread_spawn_edges.sql` |
| Worktree isolation | `reference/grok-build-main/.../worktree_pool.rs`, `xai-fast-worktree` |

---

## §0 Non-negotiable rules (read before any edit)

### 0.1 Preservation (must not lose existing work)

1. **Do not rewrite** working V2 paths from scratch. Extend and wire.
2. **Protected live modules** (edit surgically only):
   - `packages/core/src/session/subagent-registry.ts`
   - `packages/core/src/session/subagent-lifecycle.ts`
   - `packages/core/src/session/subagent-permissions.ts`
   - `packages/opencode/src/tool/tool-host-bridges.ts`
   - `packages/core/src/session/runner/llm.ts` (hook sites already present)
   - `packages/core/src/session/runtime.ts`
3. **Before deleting any file:** run the inventory gate in Task 0; deletion only when zero production consumers.
4. **Every task:** green tests for that area **before** next task. No “fix later”.
5. **No deferred TODOs in landed code** for items in this plan’s inventory. If something is out of product scope, it must be explicitly **removed** from DoD with user sign-off in Task 0 decisions log — default is **in scope**.

### 0.2 Single authority (kill dual tracks)

| Concern | ONE authority after this plan | DELETE or DEAD-MARK alternatives |
|---------|-------------------------------|----------------------------------|
| Subagent lifecycle state | `SubagentRegistry` | — |
| Subagent progress / stall | registry `lastHeartbeatAt` progress-only + 180s | delete `loop-control/subagent-heartbeat.ts` production use |
| Subagent completion → parent loop | **Both**: `SessionEvent.Subagent.*` (SDK/TUI) **and** parent `SessionRuntime.eventBus` `SubagentCompleted/Failed` (loop hooks) — published from **one** host function | no second inject path |
| Parent-history fork | `session/fork-mode.ts` (`projectParentTrace`) | delete `loop-control/fork-mode.ts` after V1 task gone |
| Task spawn | `core/tool/task.ts` + `tool-host-bridges.ts` | delete V1 `opencode/src/tool/task.ts` spawn after inventory |
| Permissions for child | `session/subagent-permissions.ts` + `PermissionV2.configured` | delete V1 `agent/subagent-permissions.ts` if unused |
| Spawn edge Open/Closed | `loop-control/spawn-edge.ts` owned by host + registry transition | not a parallel state machine |
| Goal / verifier | `GoalStore` per `SessionRuntime` + `LoopControlHost` | no global GoalStore alone for multi-session |
| Persona identity | new `persona/*` + `EffectiveSubagentConfig` on child session metadata | not a bare string on Agent only |

### 0.3 Locked product decisions (no re-open mid-implementation)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Empty goal | **Auto-seed** from first user text of the drain (truncated, max 2k chars) when `GoalStore.get === ""`. `/loop goal …` overrides. Verifier **always** can run after seed. |
| D2 | Subagent → EventBus | **Must bridge** from Task host `notifyParent` / foreground settle into **parent** `SessionRuntime.eventBus`. |
| D3 | SpawnEdge | **Wire on V2 host** Open at register, Closed on terminal transition. |
| D4 | DoomLoop / CircuitBreaker | **Wire into real hooks**; not test-only. |
| D5 | ContextEngine | **Call real compaction** when proactive trigger fires (token path remains; re-enable step-budget proactive as **additional** path via ContextEngine). |
| D6 | Fork inheritance | Keep text projection default; **add** optional structured message insert when `fork_mode` is LastNTurns/FullHistory and config `task.fork_structured: true` (default **true** once seq-safe). |
| D7 | Persona | Implement full 7 layers per persona spec; soft-fail missing files. |
| D8 | Worktree isolation | Ship `isolation?: "none" \| "worktree"` on Task input + agent; worktree pool minimal (create/remove under project `.opencode/worktrees/`). |
| D9 | Sibling messaging | Ship envelope via SessionInput.admit to address path; registry `address` is routing key. |
| D10 | Tree token budget | Optional session-level cost/token cap on `SessionRuntime` (default **off** via config; when on, hard stop like budget). |
| D11 | SubtaskPart | **Extend** V2 prompt attachments for subtask spawn fields (product choice A); stop silent drop. |
| D12 | V1 deletion | After inventory: delete dead task/spawn/permissions duals; SessionPrompt only retained if still required for non-migrated shell/compat — migrate or delete, no zombie registry. |

### 0.4 Definition of Done (batch gate — all must pass)

Print this checklist at the end of execution and tick every line with evidence (test name or command output):

- [ ] **G1** New session without `/loop goal`: goal auto-seeded; verifier audits at least one “stop-like” turn when worker claims done (integration test).
- [ ] **G2** `/loop goal` override works; `/loop status` shows goal/budget/terminal/worker from **same** SessionRuntime instance as runner.
- [ ] **G3** TimerDaemon StopReminder / WaitIdleBackup / 24h hard_timeout produce **observable** harness effects (inject or terminal), not EventBus-only noise.
- [ ] **G4** Subagent complete/fail publishes EventBus + SessionEvent; parent WorkerState Waiting→Active on complete; fail policy applied.
- [ ] **G5** SpawnEdge Open→Closed once; double-close safe; listable from `/loop status` or registry snapshot.
- [ ] **G6** DoomLoop signal can request terminal; CircuitBreaker opens after N classified failures.
- [ ] **G7** Parent IterationBudget 90 + child independent cap 50 (configurable); `acquireAgentGuard` used at V2 spawn.
- [ ] **G8** ContextEngine proactive compact triggers real compaction path at least once in test.
- [ ] **G9** Soft concurrency 4–6 surfaces in task description or tool error soft text; hard cap 7 rejects; same-type cap enforced.
- [ ] **G10** SessionIdle lifecycle event produced when session goes idle.
- [ ] **G11** Persona: load, spawn override, SystemPart inject, resume fingerprint, discovery IO line.
- [ ] **G12** Worktree isolation spawn + cleanup; escape rejected.
- [ ] **G13** Sibling message to address delivered to target child/parent.
- [ ] **G14** Tree token budget when enabled stops drain.
- [ ] **G15** SubtaskPart no longer silently dropped (spawn or explicit error).
- [ ] **G16** Confirmed-dead V1 dual files removed; `rg` proves no imports; typecheck green.
- [ ] **G17** Full regression: `packages/core` + `packages/opencode` + relevant `packages/tui` tests pass; no new dual path introduced.
- [ ] **G18** Inventory matrix §14 every row `CLOSED` with task id.

### 0.5 Anti-half-closure rules

Forbidden phrases in PRs/commits for this batch: “follow-up”, “later”, “deferred”, “good enough”, “intentionally not bridged”.  
If a task is blocked, **stop the batch and report** — do not mark inventory CLOSED.

### 0.6 Test & commit conventions

- Tests from package dir: `cd packages/core && bun test …`
- No `as any` / `@ts-ignore` / `Schema.Any`
- Commits: `feat(core): …` / `fix(core): …` / `refactor(opencode): remove dead V1 task path`
- User must request before force-push; normal commits OK per task

---

## §1 File map (create / modify / delete)

### Create

| File | Responsibility |
|------|----------------|
| `packages/core/src/session/persona/schema.ts` | Persona config schema |
| `packages/core/src/session/persona/loader.ts` | Load workspace/user/bundled personas |
| `packages/core/src/session/persona/resolve.ts` | Precedence → `EffectiveSubagentConfig` |
| `packages/core/src/session/persona/fingerprint.ts` | Instructions hash |
| `packages/core/src/session/persona/inject.ts` | SystemPart builder (`<persona>…</persona>` grok-style) |
| `packages/core/src/session/loop-control/event-bridge.ts` | Helpers: publish Subagent* to parent EventBus |
| `packages/core/src/session/loop-control/doom-loop-watch.ts` | Wire DoomLoop signals from turn text/tool tails |
| `packages/core/src/session/worktree-pool.ts` | Minimal worktree create/remove |
| `packages/core/src/session/tree-budget.ts` | Optional tree token/cost budget |
| `packages/core/src/session/sibling-message.ts` | Address-based admit helper |
| `packages/core/test/...` | Matching tests per task |
| `packages/tui/src/feature-plugins/sidebar/loop-panel.tsx` (or extend existing) | Goal/budget/terminal display |

### Modify (primary)

| File | Change |
|------|--------|
| `session/runner/loop-control-host.ts` | DoomLoop, CircuitBreaker, timer consumer side-effects, goal already used |
| `session/runner/llm.ts` | Auto-seed goal; ContextEngine compact call; persona SystemPart; SessionIdle; tree budget check |
| `session/runtime.ts` | Child budget factory hook; tree budget; circuit breaker instance if per-session |
| `session/runner/context-engine.ts` | Real compact callback injection |
| `session/runner/verifier.ts` | Harden N=8 + independent auditor (keep session-map reuse) |
| `tool/task.ts` (core) | persona, isolation, soft desc, same-type cap, structured soft text |
| `tool/tool-host-bridges.ts` | EventBus bridge, SpawnEdge, agent guard, child budget, persona resolve, worktree, structured bg complete |
| `session/subagent-identity.ts` | Persona + fingerprint resume |
| `session/subagent-registry.ts` | SessionIdle dispatch helper; optional rehydrate |
| `session/fork-mode.ts` | Structured insert helper (seq-safe) |
| `config/agent.ts` + `plugin/agent.ts` | `persona` default field |
| `schema` agent + session-event as needed | persona fields; durable events already exist |
| `tool/registry.ts` | Discovery IO from persona |
| TUI sidebar / footer | Loop panel |
| HTTP session handler | Already /loop; ensure only SessionRuntime path |

### Delete (only after Task 0 inventory proves dead)

| Candidate | Condition |
|-----------|-----------|
| `packages/opencode/src/tool/task.ts` V1 spawn | Zero production callers after migrate TUI render types |
| `packages/opencode/src/agent/subagent-permissions.ts` | Zero imports |
| `packages/core/src/session/loop-control/subagent-heartbeat.ts` | Replaced by registry stall; tests moved or deleted |
| `packages/core/src/session/loop-control/fork-mode.ts` | After V1 gone; tests point to `session/fork-mode.ts` |
| `packages/core/src/session/loop-control/task-hook.ts` | After EventBus bridge from host; tests assert host bridge |
| Dead `loop-control` test-only duplicates | After wiring real modules |

**Do not delete** SessionPrompt wholesale in Task 0 — inventory first; migrate command/shell consumers; delete only proven-dead slices.

---

## §2 Phase overview (single plan task order)

```
Task 0  Inventory + baseline freeze + decision log
Task 1  Goal auto-seed + verifier always-on path + /loop same-instance proofs
Task 2  TimerDaemon effects (StopReminder / WaitIdle / hard_timeout)
Task 3  Subagent → EventBus bridge + WorkerState + SpawnEdge on V2 host
Task 4  DoomLoop + CircuitBreaker production wire
Task 5  Parent/child IterationBudget + acquireAgentGuard on V2 spawn
Task 6  ContextEngine → real compaction
Task 7  Subagent soft/hard/same-type concurrency + dynamic description
Task 8  SessionIdle producer + background structured complete payload
Task 9  Fork structured inheritance (seq-safe) + dead fork-mode collapse
Task 10 Persona full stack (loader → EffectiveConfig → SystemPart → resume → discovery)
Task 11 Worktree isolation
Task 12 Sibling messaging
Task 13 Tree token/cost budget
Task 14 SubtaskPart V2 support (no silent drop)
Task 15 TUI loop panel (goal/budget/terminal/subagent)
Task 16 V1 dead-code deletion (post-inventory re-check)
Task 17 Full regression + §14 matrix CLOSED + DoD G1–G18
```

---

### Task 0: Inventory, baseline, freeze

**Files:**
- Create: `docs/superpowers/plans/2026-08-07-loop-subagent-full-convergence-baseline.md` (run log)
- Modify: none of production yet

- [ ] **Step 1: Capture baseline**

```bash
cd /home/huyongjun/openpartner/opencode/packages/core && bun test 2>&1 | tail -30
cd /home/huyongjun/openpartner/opencode/packages/opencode && bun test 2>&1 | tail -30
```

Record pass/fail counts in baseline.md. **Do not proceed if unrelated reds** without noting them.

- [ ] **Step 2: Production consumer inventory (must be tables in baseline.md)**

Run and paste results:

```bash
# V1 Task tool
rg -n "from [\"']@/tool/task|from [\"']\\.\\./tool/task|opencode/src/tool/task" packages --glob '!**/node_modules/**'
# SessionPrompt
rg -n "SessionPrompt" packages/opencode/src --glob '!**/node_modules/**'
# loop-control duals
rg -n "loop-control/subagent-heartbeat|loop-control/fork-mode|loop-control/task-hook|agent/subagent-permissions" packages --glob '!**/node_modules/**' --glob '!**/*.test.ts'
```

Classify each hit: `PROD` | `TEST` | `DEAD`.

- [ ] **Step 3: Snapshot protected hashes (optional but recommended)**

```bash
git status -sb
git rev-parse HEAD
```

- [ ] **Step 4: Commit baseline log only**

```bash
git add docs/superpowers/plans/2026-08-07-loop-subagent-full-convergence-baseline.md
git commit -m "docs: baseline for loop-subagent full convergence batch"
```

---

### Task 1: Goal auto-seed + verifier product path

**Closes:** L-M1, L-D1, part L-M8

**Files:**
- Modify: `packages/core/src/session/runner/llm.ts` (`buildDrainContext` / `runTurnAttempt`)
- Modify: `packages/core/src/session/loop-control/goal-store.ts` (optional `setIfEmpty`)
- Test: `packages/core/test/runner/llm-loop-control.test.ts` (extend)
- Test: `packages/core/test/session/goal-autoseed.test.ts` (create)

- [ ] **Step 1: Failing test — empty goal seeds from first user message**

```typescript
// packages/core/test/session/goal-autoseed.test.ts
import { expect, test } from "bun:test"
import { Effect } from "effect"
// Use existing runner test harness patterns from llm-loop-control.test.ts:
// 1) create SessionRuntime instance
// 2) admit a user message "Fix parser bug in src/a.ts"
// 3) run one drain turn with hooks
// 4) expect instance.goalStore.get === seeded text (prefix match)
// 5) onStreamComplete with finishReason stop runs verifier path (spy auditor)
```

- [ ] **Step 2: Implement `GoalStore.setIfEmpty`**

```typescript
// goal-store.ts — add to Interface
readonly setIfEmpty: (goal: string) => Effect.Effect<boolean> // true if set

// make:
const setIfEmpty = (goal: string) =>
  SynchronizedRef.modify(ref, (cur) => {
    if (cur.trim().length > 0) return [false, cur] as const
    const next = goal.trim().slice(0, 2000)
    return [true, next] as const
  })
```

- [ ] **Step 3: In `runTurnAttempt` after session load, before model resolve**

```typescript
const existingGoal = yield* drain.goalStore.get // need goalStore on DrainContext
if (!existingGoal.trim()) {
  const entries = yield* SessionHistory.entriesForRunner(db, session.id, 0).pipe(Effect.orDie)
  const firstUser = entries.map(e => e.message).find(m => m.type === "user" && m.text?.trim())
  if (firstUser && firstUser.type === "user" && firstUser.text) {
    yield* drain.goalStore.setIfEmpty(firstUser.text)
  }
}
```

Expose `goalStore` on `DrainContext` from `buildDrainContext`.

- [ ] **Step 4: Verifier path already skips empty goal — with seed, existing `onStreamComplete` runs.** Ensure workerClaim uses assistant text; keep N=8.

- [ ] **Step 5: Tests pass + commit**

```bash
cd packages/core && bun test test/session/goal-autoseed.test.ts test/runner/llm-loop-control.test.ts
git commit -m "feat(core): auto-seed loop goal so verifier runs by default"
```

---

### Task 2: TimerDaemon events → harness effects

**Closes:** L-M3, L-M4 (wait/idle core)

**Files:**
- Modify: `packages/core/src/session/runner/loop-control-host.ts` (EventBus subscribe cases)
- Modify: `packages/core/src/session/loop-control/timer-daemon.ts` (if harness Busy/Idle mapping wrong)
- Modify: `packages/core/src/session/loop-control/worker-state.ts` (ensure Busy/Idle mirrors drain)
- Test: `packages/core/test/loop-control/timer-effects.test.ts`

**Behavior lock:**
| Event | Effect |
|-------|--------|
| `StopReminder` | Inject synthetic system feedback via `VerifierBiDirectional` or EventBus-observed counter + optional parent admit **only if** session still Busy >5m without progress (use worker state) |
| `WaitIdleBackupTick` | If WorkerState Waiting and any child `SubagentRegistry` active for parent → no-op wait; if Waiting with **no** children and no pending input → optional soft wake is **not** forced; if Waiting **with** lost children → terminal note |
| `LoopTerminated` reason `loop_timer_reached_24h` | already requests hard_timeout — assert `shouldContinue === false` |

- [ ] **Step 1: Failing tests for StopReminder → injectRejectReason or dedicated timer feedback field**
- [ ] **Step 2: In `buildRealHooks` EventBus subscribe, handle new cases (not only Abort/Subagent*)**
- [ ] **Step 3: Align `workerState` harness Busy when `onTurnStart`, Idle on drain end (`onTurnEnd` needsContinuation false)**
- [ ] **Step 4: Tests + commit** `feat(core): timer daemon effects for stop reminder and hard timeout`

---

### Task 3: Subagent EventBus bridge + SpawnEdge on V2

**Closes:** L-M2, L-U5, L-U7, S-D1, S-D2 (authority)

**Files:**
- Create: `packages/core/src/session/loop-control/event-bridge.ts`
- Modify: `packages/opencode/src/tool/tool-host-bridges.ts`
- Modify: `packages/core/src/session/runtime.ts` (optional accessor)
- Test: `packages/opencode/test/tool/task-event-bridge.test.ts`
- Test: `packages/core/test/loop-control/spawn-edge-host.test.ts`

**Reference:** Codex ThreadSpawnEdge Open/Closed.

- [ ] **Step 1: `publishSubagentTerminal` helper**

```typescript
// event-bridge.ts
export const publishSubagentTerminal = (input: {
  eventBus: EventBus.Interface
  parentSessionID: string
  childSessionID: string
  ok: boolean
  error?: string
}) =>
  input.ok
    ? EventBus.publish({
        _tag: "SubagentCompleted",
        parentSessionID: input.parentSessionID,
        childSessionID: input.childSessionID,
      }).pipe(Effect.provideService(EventBus.Service, input.eventBus))
    : EventBus.publish({
        _tag: "SubagentFailed",
        parentSessionID: input.parentSessionID,
        childSessionID: input.childSessionID,
        error: input.error ?? "failed",
      }).pipe(Effect.provideService(EventBus.Service, input.eventBus))
```

- [ ] **Step 2: In Task host, resolve parent SessionRuntime instance**

```typescript
const runtimeOpt = yield* Effect.serviceOption(SessionRuntime.Service)
// in notifyParent + foreground settle success/fail:
if (Option.isSome(runtimeOpt)) {
  const inst = yield* runtimeOpt.value.getOrCreate(parentID)
  yield* publishSubagentTerminal({
    eventBus: inst.eventBus,
    parentSessionID: String(parentID),
    childSessionID: String(childSessionID),
    ok: state === "completed",
    error: state === "error" ? text : undefined,
  })
  // SpawnEdge close on inst-owned map OR module-level SynchronizedRef keyed by child
}
```

- [ ] **Step 3: SpawnEdge** — on register `SpawnEdge.make(parent, child)`; store in host-local `Map` or registry side table; on terminal `SpawnEdge.close`.

- [ ] **Step 4: Integration test:** parent hooks transition Waiting→Active on SubagentCompleted.

- [ ] **Step 5: Mark `task-hook.ts` as deprecated wrapper calling same bridge OR delete in Task 16.**

- [ ] **Step 6: Commit** `feat(opencode): bridge subagent completion into session loop EventBus`

---

### Task 4: DoomLoop + CircuitBreaker production

**Closes:** L-U1, L-U2

**Files:**
- Modify: `loop-control/doom-loop.ts` (add detector pure functions if only schemas exist)
- Modify: `loop-control/circuit-breaker.ts` (ensure open/half-open API)
- Modify: `loop-control-host.ts` `onStreamComplete` / `onFailover`
- Test: `packages/core/test/loop-control/doom-loop-wire.test.ts`

**Behavior:**
- **DoomLoop:** if last N assistant texts nearly identical (normalized) OR same tool name+args hash ≥ K times → `terminal.request("doom_loop")` + EventBus publish.
- **CircuitBreaker:** onFailover non-retryable or repeated same reason ≥ threshold → open; `shouldContinue` false while open; `/loop` can reset.

- [ ] **Step 1–5:** TDD wire + commit `feat(core): wire doom-loop and circuit-breaker into loop hooks`

---

### Task 5: Parent/child IterationBudget + agent guard

**Closes:** L-M6, S-U4, part L-U (Hermes parity)

**Files:**
- Modify: `loop-control/iteration-budget.ts` (export `defaultSubagentCap = 50`, keep parent 90)
- Modify: `tool-host-bridges.ts` — `acquireAgentGuard` at spawn; child session uses own budget in runner when `session.parentID` set
- Modify: `runtime.ts` / `llm.ts` — if session has parentID, `IterationBudget.make(subagentCap)` instead of parent cap
- Test: `packages/core/test/loop-control/iteration-budget-child.test.ts`
- Test: `packages/opencode/test/tool/task-agent-guard.test.ts`

**Reference:** hermes `iteration_budget.py` — independent caps, total may exceed parent.

- [ ] **Step 1:** Failing test child drain uses cap 50
- [ ] **Step 2:** `buildDrainContext` chooses cap by parentID
- [ ] **Step 3:** Host spawn `yield* budget.acquireAgentGuard` with release on terminal (Scope finalizer)
- [ ] **Step 4:** Commit `feat(core): independent parent/subagent iteration budgets and spawn guard`

---

### Task 6: ContextEngine real compaction

**Closes:** L-M5, L-D6

**Files:**
- Modify: `session/runner/context-engine.ts` — accept `compactFn` or call Session compaction service
- Modify: `llm.ts` — re-enable proactive check via ContextEngine (alongside token compactIfNeeded)
- Test: `packages/core/test/runner/context-engine-wire.test.ts`

```typescript
// In runTurnAttempt after budget consume / before stream:
if (yield* drain.contextEngine.shouldProactiveCompact) {
  const did = yield* compaction.compactIfNeeded({ sessionID, entries, model, request: /* minimal */ })
  // or dedicated compactNow
  if (did) {
    yield* drain.contextEngine.compact
    return yield* Effect.die(continueAfterCompaction(currentStep))
  }
}
```

Wire `contextEngine` onto `DrainContext`.

- [ ] Commit `feat(core): context-engine triggers real compaction`

---

### Task 7: Concurrency soft/hard/same-type + description

**Closes:** S-P1, S-P2, G9

**Files:**
- Modify: `packages/core/src/tool/task.ts`
- Modify: `packages/core/src/tool/registry.ts` `describeTaskAgents` optional soft line
- Test: `packages/core/test/tool-task-budget.test.ts` (extend)

```typescript
// execute path
const active = yield* registry.activeCount
const byType = yield* registry.activeCountByType(input.subagent_type)
if (byType >= 2) {
  return yield* new ToolFailure({ message: `Too many active "${input.subagent_type}" subagents (max 2).` })
}
if (active >= CONCURRENCY_HARD_CAP) { /* existing */ }
// Soft: append to description is hard with static string — instead prefix tool failure is wrong.
// Approach: dynamic description function if Tool.make supports; else inject soft warning into
// permission.assert success path by mutating toModelOutput only when soft:
// Better: registry.describe appends "\nNote: N subagents active; prefer fewer parallel tasks." when active>=4
```

- [ ] Commit `feat(core): subagent soft concurrency hints and same-type cap`

---

### Task 8: SessionIdle + background structured complete

**Closes:** S-P4, S-P6

**Files:**
- Modify: `llm.ts` run ensuring path when status→idle
- Modify: `subagent-lifecycle.ts` already has SessionIdle — **dispatch** from llm ensuring + message-updater idle
- Modify: `tool-host-bridges.ts` `notifyParent` include structured JSON block in inject text

```xml
<task id="..." state="completed">
  <task_result>...</task_result>
  <structured exit="completed" turns="3" />
</task>
```

- [ ] Commit `feat(core): SessionIdle lifecycle and structured background task results`

---

### Task 9: Fork structured inheritance + collapse dual fork-mode

**Closes:** S-P3, S-D3, L-U8

**Files:**
- Modify: `session/fork-mode.ts` — add `projectParentMessagesForInsert` returning lightweight message drafts
- Modify: `tool-host-bridges.ts` — if fork_mode != PromptOnly, prefer structured admit sequence **if** seq API allows; else keep text but add tests for both
- Delete path prepared for `loop-control/fork-mode.ts` in Task 16
- Test: `packages/core/test/fork-mode-structured.test.ts`

**Seq-safe algorithm (lock):**
1. `admitPrompt` first message = user task text only  
2. Before admit, if structured: `SessionInput.admit` a synthetic user/system message carrying projected trace as **single** text part with header `Parent trace (structured)` — still one admit, zero uniqueIndex risk  
3. Document: true multi-row insert deferred only if single synthetic message insufficient — **prefer single synthetic message** to guarantee seq safety (still better than silent PromptOnly)

- [ ] Commit `feat(core): structured parent-trace inheritance for fork_mode`

---

### Task 10: Persona full stack

**Closes:** P-1…P-7, S-P8, G11

**Spec:** `docs/superpowers/specs/2026-08-07-subagent-persona.md` — **accepted**.  
**Prompt shape reference:** grok `subagent_prompt.md` lines 75–84 (`<persona>${persona_instructions}</persona>`).

**Files:** create persona/* as §1; modify task Input; host; identity; llm system parts; agent config; registry discovery.

#### 10.a Schema + loader

```typescript
// persona/schema.ts
export class PersonaInfo extends Schema.Class<PersonaInfo>("Persona.Info")({
  name: Schema.String,
  instructions: Schema.String.pipe(Schema.optional),
  instructions_file: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  inputs: Schema.Array(Schema.String).pipe(Schema.optional),
  outputs: Schema.Array(Schema.String).pipe(Schema.optional),
  capability: Schema.Literals(["read-only", "read-write", "execute", "all"]).pipe(Schema.optional),
}) {}

export class EffectiveSubagentConfig extends Schema.Class<EffectiveSubagentConfig>("Persona.Effective")({
  personaName: Schema.String.pipe(Schema.optional),
  instructions: Schema.String,
  source: Schema.Literals(["task_override", "agent_default", "parent", "none"]),
  path: Schema.String.pipe(Schema.optional),
  fingerprint: Schema.String,
  inputs: Schema.Array(Schema.String).pipe(Schema.optional),
  outputs: Schema.Array(Schema.String).pipe(Schema.optional),
  capabilityTighten: Schema.Literals(["read-only", "read-write", "execute", "all"]).pipe(Schema.optional),
}) {}
```

Load paths (priority):  
`.opencode/personas/*.md` → `~/.config/opencode/personas/*.md` → bundled defaults.

Frontmatter + body = instructions (same as agents).

- [ ] **Soft-fail** missing `instructions_file`: log + empty instructions extension.

#### 10.b Resolve precedence

1. `task.persona`  
2. `agent.persona` (new optional field on ConfigAgent / AgentV2.Info)  
3. none  

#### 10.c Persist on child session

Store JSON of `EffectiveSubagentConfig` in session metadata or dedicated column if exists; if only permission/title available, use `SessionV1.SessionInfo` extension field **only if schema allows** — prefer `SessionStore` metadata map. If no metadata: store fingerprint + name in registry record (extend `SubagentRecord` optional fields).

#### 10.d SystemPart inject in llm.ts

```typescript
system: [
  agent.info?.system,
  system.baseline,
  personaPart, // from EffectiveSubagentConfig on session — NOT user admit text
  verifierFeedback,
].filter(Boolean).map(SystemPart.make)
```

Persona body format (from grok):

```text
<persona>
${instructions}
</persona>
```

#### 10.e Task Input

```typescript
persona: Schema.String.pipe(Schema.optional)
```

#### 10.f Resume

`validateResumeIdentity`: if child has personaName and request has different persona → fail; if request omits → ok inherit.

#### 10.g Discovery

```text
- explore [read-only] (persona:researcher): blurb | in: paths out: summary
```

- [ ] Tests for each layer + commit `feat(core): subagent persona registry, inject, and resume pin`

---

### Task 11: Worktree isolation

**Closes:** S-U1, G12

**Reference:** grok-build worktree_pool.

**Files:**
- Create: `packages/core/src/session/worktree-pool.ts`
- Modify: core `task.ts` Input `isolation?: "none" | "worktree"`
- Modify: `tool-host-bridges.ts` `resolveChildDirectory` / create worktree before session
- Test: `packages/opencode/test/tool/task-worktree.test.ts`

```typescript
// worktree-pool.ts sketch
export const acquire = (projectRoot: string, childID: string) =>
  Effect.gen(function* () {
    const dir = path.join(projectRoot, ".opencode", "worktrees", childID)
    // git worktree add dir HEAD  (Effect.tryPromise exec)
    // on failure: ToolFailure
    return dir
  })
export const release = (projectRoot: string, childID: string) => /* worktree remove --force */
```

Call `release` on terminal transition (host notifyParent / cancel).

- [ ] Commit `feat(opencode): optional worktree isolation for subagents`

---

### Task 12: Sibling messaging

**Closes:** S-U3, G13

**Files:**
- Create: `packages/core/src/session/sibling-message.ts`
- Modify: optional tool or Task host internal — prefer **small tool** `peer_message` registered only for subagents with capability, OR host API used by lifecycle. **Simpler:** extend Task tool is wrong. Add `packages/core/src/tool/peer.ts` thin tool: `{ to_address, text }` resolves registry by address prefix, admit to target session.

- [ ] Commit `feat(core): sibling subagent messaging by registry address`

---

### Task 13: Tree token/cost budget

**Closes:** S-U2, G14, D10

**Files:**
- Create: `packages/core/src/session/tree-budget.ts`
- Modify: `runtime.ts` instance field; `llm.ts` after usage events debit; config key `loop.tree_budget_tokens?: number` default undefined (off)
- When exceeded: `terminal.request("tree_budget_exhausted")`

- [ ] Commit `feat(core): optional session tree token budget`

---

### Task 14: SubtaskPart V2 (no silent drop)

**Closes:** X-1, G15

**Files:**
- Modify: V2 prompt admission path that logs `subtask parts dropped`
- Extend Prompt schema / attachment to carry `{ type: "subtask", name, prompt, description?, command? }`
- On admit: convert to Task tool invocation **or** auto-spawn via host once

**Decision lock D11:** convert to internal Task spawn with `subagent_type = name`.

- [ ] Commit `feat(core): honor subtask parts on V2 prompt path`

---

### Task 15: TUI loop panel

**Closes:** L-M8 remainder, G2 display

**Files:**
- Create/modify: `packages/tui/src/feature-plugins/sidebar/loop-panel.tsx`
- Register in builtins next to subagents
- Data: poll `/loop status` via existing command API **or** client events for budget (prefer command invoke on open + session status events)

Show: goal (truncated), terminal state, budget remaining, active subagent count, circuit breaker.

- [ ] Commit `feat(tui): loop control sidebar panel`

---

### Task 16: V1 / dead dual deletion

**Closes:** S-D3, S-D4, S-D5, L-U5, L-U6, L-U8, X-2 slice, G16

**Gate:** Re-run Task 0 inventory. Only delete rows still `DEAD` or migrated.

**Procedure per file:**
1. `rg` imports  
2. Move still-needed types to core  
3. Delete file  
4. Fix tests  
5. `bun typecheck` in package  

**Minimum delete set (if inventory allows):**
- `loop-control/subagent-heartbeat.ts` + its test (authority = registry)
- `loop-control/fork-mode.ts` + retarget tests to `session/fork-mode.ts`
- `loop-control/task-hook.ts` if bridge fully replaces
- V1 `opencode/src/tool/task.ts` **only if** V1 ToolRegistry not on prod path; else strip spawn and leave stub throwing “use V2”
- `opencode/src/agent/subagent-permissions.ts` if unused

**SessionPrompt:** If HTTP already SessionV2-only for prompt, remove SessionPrompt from app layer **only after** shell/command migration. If shell still needs it, migrate shell to V2 in this task — **do not leave dual prompt loops**.

- [ ] Commit `refactor: remove dead V1 subagent/loop dual implementations`

---

### Task 17: Full regression + inventory closure

**Closes:** G17, G18, all remaining matrix rows

- [ ] **Step 1: Run full tests**

```bash
cd /home/huyongjun/openpartner/opencode/packages/core && bun test
cd /home/huyongjun/openpartner/opencode/packages/opencode && bun test
cd /home/huyongjun/openpartner/opencode/packages/tui && bun test
cd /home/huyongjun/openpartner/opencode/packages/schema && bun test
```

- [ ] **Step 2: Fill §14 matrix** every ID → CLOSED + task number + test name

- [ ] **Step 3: DoD G1–G18** evidence in `...-baseline.md` appendix “closure”

- [ ] **Step 4: Dual-path rg audit**

```bash
rg -n "intentionally not bridged|TODO.*subagent|FIXME.*loop" packages/core/src packages/opencode/src --glob '!**/node_modules/**'
# must be empty for this batch scope
```

- [ ] **Step 5: Final commit** `test: full convergence gate green for loop-subagent batch`

---

## §14 Inventory closure matrix (executor fills)

| ID | Item | Task | Status |
|----|------|------|--------|
| L-U1 | DoomLoop production | 4 | |
| L-U2 | CircuitBreaker production | 4 | |
| L-U3 | Tracker | 4 or fold into /loop status | |
| L-U4 | PromotionGuard | 3/16 — V2 2min promote remains; delete or wire | |
| L-U5 | TaskHook | 3/16 | |
| L-U6 | loop SubagentHeartbeat | 16 delete | |
| L-U7 | SpawnEdge V2 | 3 | |
| L-U8 | Dual fork-mode | 9/16 | |
| L-M1 | Goal→Verifier | 1 | |
| L-M2 | EventBus bridge | 3 | |
| L-M3 | Timer effects | 2 | |
| L-M4 | wait/idle | 2 | |
| L-M5 | ContextEngine real | 6 | |
| L-M6 | Parent/child budget | 5 | |
| L-M7 | Verifier shape | 1 (reuse map + provider auditor; session-level ok) | |
| L-M8 | TUI loop | 15 | |
| L-M9 | ErrorClassifier depth | 4 (align thresholds with hermes) | |
| L-D1–D6 | Defects | 1–6 | |
| S-P1–P8 | Subagent tails | 7–10 | |
| S-D1–D5 | Dual tracks | 3/16 | |
| S-U1 | Worktree | 11 | |
| S-U2 | Tree budget | 13 | |
| S-U3 | Sibling | 12 | |
| S-U4 | Child budget | 5 | |
| P-1–P-7 | Persona | 10 | |
| X-1 | SubtaskPart | 14 | |
| X-2 | V1 retire slice | 16 | |
| X-4 | j/k nav | **OUT if not loop-related** — only if time; else note in baseline as **explicit non-goal of this batch** with user OK in Task 0 |

**Note on X-4 / sidebar sizing / memory:** Not part of loop-subagent convergence unless Task 0 baseline marks them in. Default **exclude** memory plans and pure UI chrome; **include** X-1 and V1 task duals.

---

## §15 Feasibility audit (pre-execution)

### 15.1 Can one batch close everything listed?

| Area | Feasible in one batch? | Risk | Mitigation |
|------|------------------------|------|------------|
| Goal + verifier default | **Yes** | Low | Auto-seed is small; hooks exist |
| Timer effects | **Yes** | Medium | Define concrete inject vs terminal; tests with fake clock |
| EventBus bridge + SpawnEdge | **Yes** | Medium | Single `notifyParent` choke point |
| DoomLoop/CircuitBreaker | **Yes** | Low–Med | Pure detect + terminal.request |
| Child budgets + guard | **Yes** | Medium | Must not break parent-only sessions |
| ContextEngine→compact | **Yes** | Medium | Reuse compactIfNeeded; avoid double-compact loops |
| Soft concurrency | **Yes** | Low | |
| Persona 7 layers | **Yes** | **High** | Largest feature; follow spec order; soft-fail files |
| Worktree | **Yes** | **High** | git dependency; fail clear error; skip if not a git repo |
| Sibling | **Yes** | Med | Address from registry |
| Tree budget | **Yes** | Low | Default off |
| SubtaskPart | **Yes** | Med | Schema/SDK may need regenerate |
| V1 deletion | **Yes if inventory clean** | **High** | Task 0+16 gates; stub not silent dual |
| TUI panel | **Yes** | Low | |
| j/k / memory | **Excluded** | — | Prevents infinite scope |

**Verdict:** Feasible as **one plan / one batch** if executor follows task order and **does not invent new dual paths**. Highest risk items (persona, worktree, V1 delete) are ordered **after** loop spine so spine cannot be left half-closed if later tasks slip — but DoD still requires all; if worktree impossible in env, fail Task 11 with explicit blocker rather than CLOSED lie.

### 15.2 Regression risk to existing work

| Existing asset | Risk | Guard |
|----------------|------|-------|
| SubagentRegistry + host | Medium | Surgical edits; keep progress-only 180s |
| Foreground 2min promote | Low | Don’t replace with PromotionGuard unless tests keep behavior |
| Permission derive + capability | Low | Persona only **tightens** |
| SessionRuntime per-session | Low | Auto-seed uses same instance |
| `/loop` HTTP path | Low | Keep SessionRuntime resolution order |
| V2 prompt path | Med | Subtask + persona inject tested |

### 15.3 Half-closure failure modes (explicitly banned)

1. Bridge “documented as future” — banned; Task 3 must ship.  
2. Verifier only when user types `/loop goal` — banned; Task 1 seeds.  
3. Persona as user-prompt concat only — banned; SystemPart required.  
4. Leaving V1 task “for compat” without inventory — banned.  
5. ContextEngine still counter-only — banned; Task 6.  
6. Dual heartbeat both “live” — banned; delete loop heartbeat.  

### 15.4 Estimated effort (for staffing)

| Tasks | Rough size |
|-------|------------|
| 0–3 (spine) | 2–4 days |
| 4–9 | 2–3 days |
| 10 persona | 2–3 days |
| 11–14 | 2–3 days |
| 15–17 | 1–2 days |
| **Total** | **~10–15 engineer-days** one sequential agent stream (longer if worktree/git flaky) |

### 15.5 Go / No-Go

| Criterion | Status |
|-----------|--------|
| Live V2 spine exists to hang work on | **GO** |
| Reference implementations available | **GO** (`/home/huyongjun/reference`) |
| Single-authority table complete | **GO** |
| User requires one-shot full converge | **GO** with DoD gate |
| Unbounded scope (memory, full V1 app delete) | **NO-GO** unless added to Task 0 — default exclude memory |

**Audit conclusion:** **GO to execute this plan as the single convergence batch**, provided Task 0 inventory is honest and Tasks 16–17 are not skipped.

---

## §16 Execution handoff

Plan complete and saved to:

`opencode/docs/superpowers/plans/2026-08-07-loop-subagent-full-convergence.md`

**Execute only after user confirms.** Recommended:

1. **Subagent-Driven** (fresh subagent per Task 0→17, review between tasks)  
2. **Inline** with executing-plans + checkpoints after Tasks 3, 10, 16, 17  

**Before coding:** re-read §0 Preservation and §0.2 Single authority.

**Success criterion:** §0.4 DoD G1–G18 all evidenced + §14 matrix all CLOSED — not “mostly done”.
