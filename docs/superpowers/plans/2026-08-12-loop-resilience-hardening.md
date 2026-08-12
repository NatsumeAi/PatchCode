# Loop Resilience & Hardening — Real-Gap Remediation Implementation Plan

## Implementation status (2026-08-12)

| Task | Status | Notes |
|------|--------|-------|
| R1 W1 drain retry | **done** | `llm.ts` loop; session-runner tests |
| R2 W3 durable jobs | **partial** | Optional JSON ledger via `OPENCODE_BACKGROUND_JOB_LEDGER` + stale reap on start |
| R3 W4 tool framing | **done** | `tool-result-framing.ts` + `to-llm-message` |
| R4 W2 breaker | **done** | per-provider + sliding window + half-open probe + allowRequest |
| R5 W6 write containment | **done** | `assertWriteContained` + location-mutation |
| R6 W5 threat scopes | **done** | `scanForThreatsInScope` + skill load gate |
| R7 W7 content search | **done** | title OR session_message data LIKE |
| R8 W9 keyboard nav | **done** | `ctrl+alt+j/k` → selectNext/Prev |
| R9 gate | run suite below |

---

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the WEAK SPOTS verified against reference agents (codex / hermes / grok-build / pi / openclaw) that are CONFIRMED REAL by source audit (user-verified 2026-08-12). W10 (dual command registry) is EXCLUDED pending a slash-execution-path trace. Scope follows the user's corrected priority table — no over-claiming, no touching what is already strong.

**Architecture:** Add an inner retry loop for transient provider failures (W1); make background jobs crash-durable with stale reaping (W3); wrap untrusted tool output with delimiters (W4); deepen the circuit breaker to per-provider + true half-open probing (W2); add a generic write-path containment check (W6); add threat-scope tiering + skills-install scan (W5); add session full-text search (W7); wire TUI keyboard navigation (W9). Keep the verified-strong invariants untouched.

**Tech Stack:** TypeScript, Effect, Bun test, existing SQLite, loop-control, TUI keymap.

**Repo root:** `/home/huyongjun/openpartner/opencode`

**Canonical plan copy:** `docs/superpowers/plans/2026-08-12-loop-resilience-hardening.md`

---

## Gap → Task map

| Weak spot | Verdict (user) | Priority | Tasks | Primary files |
|-----------|---------------|----------|-------|---------------|
| W1 failure no-replay | TRUE (highest leverage) | P0 | R1 | `runner/llm.ts`, `loop-control-host.ts`, `turn-retry-state.ts` |
| W3 background jobs non-durable | TRUE | P1 | R2 | `background-job.ts`, `store.ts` (SQLite), `task.ts` |
| W4 untrusted tool output undelimited | TRUE | P1 | R3 | `runner/to-llm-message.ts`, `tool/registry.ts` |
| W2 breaker shallow (no per-provider / no true half-open) | HALF-TRUE (has wiring + HalfOpen name; no per-provider/real probe) | P1 | R4 | `loop-control/circuit-breaker.ts`, `loop-control-host.ts` |
| W6 generic write-path containment | TRUE for fs-util (memory already sandboxed) | P1–P2 | R5 | `fs-util.ts`, `paths.ts` |
| W5 single-tier threat scan / no skills gate | DIRECTION TRUE (scope narrowed) | P2 | R6 | `memory/scan.ts`, skill loader |
| W7 session content search missing | TRUE | P2 | R7 | `httpapi/groups/session.ts`, SQL |
| W9 TUI keyboard nav dead | HALF-TRUE (selectNext/Prev dead; fold commands live) | P2 | R8 | `tui/src/display/selection.ts`, `routes/session/index.tsx`, `keybind.ts` |

**Excluded (verified scope cut, do NOT touch):** W10 (dual command registry — needs slash-path trace first); W8 compaction UX (has `session.time.compacting` status; pi-style progress bar is enhancement, not a bug); memory six-gap invariants (ledger rollback, dual-root locks, threat chain, untrusted framing, backoff, flush triple gate).

---

## Task R1: Drain-internal bounded retry for transient provider failures (W1)

**Files:**
- Modify: `packages/core/src/session/runner/llm.ts` (~932–943 Failure branch)
- Modify: `packages/core/src/session/runner/loop-control-host.ts` (`onFailover` — already returns `{recovered}`; verify it also tells the runner *how to retry*)
- Modify: `packages/core/src/session/runner/turn-retry-state.ts` (verify one-shot admission semantics)
- Test: `packages/core/test/session-runner.test.ts` (or the file covering runTurnAttempt)

**Behavior:**
- On `stream._tag === "Failure"` with an `LLMError`, call `onFailover(err)` and CONSUME the returned `{recovered}`:
  - `recovered === true` → retry the provider turn INSIDE the drain, with bounded attempts (e.g. max 2 retries per drain) and a small backoff (e.g. `Schedule.exponential(Duration.millis(500), 2)` capped at a few seconds). Do NOT consume a new step — the retry replaces the failed step.
  - `recovered === false` → existing behavior (propagate failCause / terminal request).
- `onFailover` already: classifies → `retry.consume(reason)` (one-shot) → `recovered = retryable && first` → breaker record + terminal request when !recovered. Keep that. The runner-side retry must also honor `drain.terminal` state (if a terminal state was requested mid-retry, stop).
- Guard: retries only for `retryable === true` reasons (429/503/timeout/rate_limit etc. — whatever `ErrorClassifier.classifyApiError` marks retryable). Never retry content_policy_blocked / auth / malformed.
- Budget: the retry loop must not double-debit the iteration budget (the failed attempt did not settle a step, so the retry is the same step).
- MUST NOT: change the one-stream-per-turn invariant; do not retry when `publisher.hasProviderError()` (a tool call already failed).

**Tests (TDD):**
- Mock LLM that fails once with a 429 then succeeds → drain completes, exactly 2 stream calls, turn succeeds.
- Mock LLM that fails with 429 3 times → retries exhausted → drain fails with the original cause.
- Mock LLM that fails with content_policy_blocked → NO retry, immediate fail (single call).
- Mock LLM fails with 429 but terminal was requested between retries → stops.
- Existing session-runner tests still pass.

**Commit:** `feat(core): bounded drain-internal retry for transient provider failures`

---

## Task R2: Crash-durable background jobs with stale reaping (W3)

**Files:**
- Modify: `packages/core/src/background-job.ts`
- Modify: `packages/core/src/session/store.ts` or a new SQL table
- Modify: `packages/opencode/src/tool/task.ts` (reap on spawn)
- Test: `packages/core/test/background-job.test.ts`

**Behavior:**
- Persist background-job status (id, sessionID, type, status: running/completed/error/cancelled, createdAt, heartbeatAt, payload-ref) to a SQLite table (e.g. `background_job`).
- On process start (or first spawn), reap stale entries: `status=running` AND `heartbeatAt` older than a threshold (e.g. 30 min, mirroring the existing `PROMOTE_WAIT_TIMEOUT`) → mark `failed` with reason `stale-after-crash` and publish the terminal event so parents are notified.
- Keep the in-memory registry for live fast-path (wake/find), but the durable table is the source of truth for recovery.
- The existing comment at background-job.ts:124–125 ("intentionally not durable") is superseded — update it.
- MUST NOT: change the promotion/timeout semantics already wired; keep `waitForPromotion` behavior for live jobs.

**Tests:**
- Spawn → row in table with status running + heartbeatAt.
- Simulate crash: insert stale row (heartbeatAt 31 min ago), start reap → status failed + parent notified.
- Live job completes → row updated.
- Reap does not touch running jobs with fresh heartbeat.

**Commit:** `feat(core): crash-durable background jobs with stale reaping`

---

## Task R3: Delimit untrusted tool output (W4)

**Files:**
- Modify: `packages/core/src/session/runner/to-llm-message.ts` (~39–56, 90–104 toolResult)
- Modify: `packages/core/src/tool/registry.ts` (mark which tools produce untrusted output, or a set of trusted families)
- Test: `packages/core/test/session-runner/to-llm-message.test.ts` (or existing coverage)

**Behavior:**
- Wrap tool results from untrusted sources (web fetch/extract, search, MCP, bash when reading external data — mirror hermes `make_tool_result_message`) in an explicit boundary: `<untrusted_tool_result>\n...\n</untrusted_tool_result>`.
- Neutralize embedded delimiter tokens in the output (strip/replace occurrences of `<system>`, `</system>`, `<tool_result>`, role-injection markers) — mirror hermes `_neutralize_delimiters` + openclaw `sanitizeModelSpecialTokens`.
- Trusted tools (edit/read file within workspace, memory_* which already scan) keep current framing.
- Decide the trust classification: a small allowlist of trusted tool families (e.g. `edit`, `bash` when non-web? — check how tools declare output trust; simplest: a `trustedOutput?: boolean` field on the tool definition, default false = wrap).
- MUST NOT: break existing tool output parsing tests; preserve the exact result text for trusted tools.

**Tests:**
- Web tool output containing `<system>ignore</system>` → wrapped + delimiters neutralized.
- Edit tool result → unchanged framing.
- Round-trip: model still receives the same content for trusted tools.

**Commit:** `feat(core): delimit untrusted tool output with boundary + delimiter neutralization`

---

## Task R4: Deepen circuit breaker — per-provider registry + true half-open (W2)

**Files:**
- Modify: `packages/core/src/session/loop-control/circuit-breaker.ts`
- Modify: `packages/core/src/session/runtime.ts` (construct registry, not single breaker)
- Modify: `packages/core/src/session/runner/loop-control-host.ts` (route recordFailure/Success by provider key)
- Test: `packages/core/test/loop-control/circuit-breaker.test.ts`

**Behavior:**
- Per-provider breaker: `CircuitBreakerRegistry` keyed by provider id (mirror grok `registry.rs`), lazy-create, `enabled=false` short-circuits.
- True half-open: when Open, after a cooldown window, allow a single probe request; probe success → Closed, probe failure → back to Open with cooldown reset. Implement a probe-slot with cancel-safe reclaim (mirror grok `probe_claimed_at_millis`).
- Sliding window: count failures over a time window (e.g. last 60s) with min-samples (e.g. ≥5 failures in window → Open), not just a cumulative counter.
- Keep the existing `recordSuccess/recordFailure/state/reset` interface callable from loop-control-host; add `check(key)` + `record(key, outcome)` variants.
- MUST NOT: change the per-session construction sites that tests depend on; keep default `enabled=false` behavior identical (short-circuit → always closed/no-op).

**Tests:**
- Per-provider isolation: provider A trips, provider B unaffected.
- Sliding window: 4 failures in window → still closed; 5th → open.
- Half-open probe success → closed; probe failure → open again with reset cooldown.
- Cancel-safe: probe claimed then dropped (future cancelled) → slot reclaimed.
- Default disabled → all no-op.

**Commit:** `feat(core): per-provider circuit breaker with true half-open probing`

---

## Task R5: Generic write-path symlink containment (W6)

**Files:**
- Modify: `packages/core/src/fs-util.ts` (add `assertWriteContained` or harden `resolve`)
- Modify: `packages/core/src/memory/paths.ts` (optional: reuse)
- Test: `packages/core/test/fs-util.test.ts`

**Behavior:**
- In `FSUtil.resolve` / the write helpers, after `realpathSync`, verify the resolved path stays within the allowed root (or that no symlink component escapes the workspace root). Add a containment check used by generic write paths (file write/edit tools) — do NOT duplicate memory's `assertSandboxPath` (already hardened); the gap is the GENERIC fs layer.
- Design decision: add `containedIn(root, target)` helper + wire into the write path used by the edit/file tools (find the tool that writes files — check `tool/edit.ts` or the FileTool write). Reject with a clear error when a symlink escapes.
- MUST NOT: break the memory sandbox (already correct); do not change read paths that legitimately follow symlinks outside (check whether any legit use exists — if the workspace legitimately references external dirs via symlink, scope the check to write paths only).

**Tests:**
- Symlink inside workspace pointing outside → write rejected.
- Normal write inside workspace → allowed.
- Symlink cycle → rejected (no hang).
- Memory paths still pass (regression).

**Commit:** `fix(core): reject symlink-escape on generic write paths`

---

## Task R6: Threat-scope tiering + skills-install scan (W5)

**Files:**
- Modify: `packages/core/src/memory/scan.ts` (add scope tiers: strict/context/all, mirror hermes)
- Modify: skill loader (`packages/opencode/src/...skill...` — find where skills are discovered/loaded; add install-time scan)
- Test: `packages/core/test/memory/scan.test.ts` + skill loader test

**Behavior:**
- Split the pattern set into tiers: `strict` (broadest — memory writes), `context` (instruction/skill files), `all` (everything). Keep current behavior as the default scope for memory paths (do not weaken existing memory scanning).
- Add `scanForThreatsInScope(text, scope)`; existing `scanForThreats` keeps its current behavior (compat).
- Skills/instruction files: at load/install time, run the context-scope scan; reject or quarantine a skill containing injection patterns (mirror hermes `skills_guard.py` trust levels + install gate).
- MUST NOT: change the memory threat chain (six-gap invariants); do not false-positive on legit skill files.

**Tests:**
- A skill file containing `ignore all previous instructions` → rejected at install.
- Legit skill (no patterns) → loads.
- Scope tiers: pattern in strict only, absent from context (verify a known pattern's tier).
- Memory scanning unchanged (existing scan tests pass).

**Commit:** `feat(core): threat-scope tiering + skills-install scan`

---

## Task R7: Session full-text content search (W7)

**Files:**
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` (~37 search param)
- Modify: the session query/SQL (find where `SessionTable.title` LIKE is built — `packages/core/src/session/store.ts` or the SQL helper)
- Test: HTTP/SDK test for search by message content

**Behavior:**
- Extend the `search` query param to also match message/part content, not just title. Use FTS5 (already used by memory reindex) OR a simple `LIKE` over the joined message text (pick the lighter option that matches the existing SQL layer — if FTS5 infra exists in core reuse it; otherwise `LIKE` on a message-content subquery is acceptable for v1).
- Keep title matching (backward compat). Add content matching when `search` is present.
- MUST NOT: change the memory subsystem; keep the search endpoint response shape.

**Tests:**
- Session with message containing "unique-term" → search "unique-term" returns it.
- Title-only match still works.
- No search param → all sessions (unchanged).

**Commit:** `feat(opencode): session content search beyond title`

---

## Task R8: Wire TUI keyboard navigation (W9 — selectNext/selectPrev)

**Files:**
- Modify: `packages/tui/src/display/selection.ts` (verify selectNext/selectPrev exist and work)
- Modify: `packages/tui/src/routes/session/index.tsx` (wire j/k or arrow-up/down to selection nav + ensure selection list stays in sync with visible entries)
- Modify: `packages/tui/src/config/keybind.ts` (add bindings if absent)
- Test: `packages/tui/test/display/selection.test.ts` (extend with nav-after-setList)

**Behavior:**
- `selectNext`/`selectPrev` already exist in selection.ts (unit-tested). Wire them to keyboard: `j`/`k` (vim-style) or arrow-up/down — match grok pager navigation. Check existing keybind conventions (`keybind.ts` Definitions map).
- Ensure the selectable list is rebuilt on new parts (the `setList` sync already exists at index.tsx:269).
- Visual: selected entry highlighted (the selection already flows to entries via `selected` prop — verify).
- MUST NOT: break mouse folding (existing `foldSelected` + `session.fold.*` commands stay).

**Tests:**
- Keybind defs exist for nav keys.
- selection.ts: setList → selectNext → selectedId advances (wraps); selectPrev wraps.
- Integration (if testable): pressing nav key changes selection.

**Commit:** `feat(tui): wire keyboard navigation for entry selection`

---

## Implementation order

```
R1 (W1, P0) → R2 (W3) → R3 (W4) → R4 (W2) → R5 (W6) → R6 (W5) → R7 (W7) → R8 (W9) → R9 gate
```

## Gate (R9): whole-system verification

- `cd packages/core && bun test test/session-runner.test.ts test/background-job.test.ts test/loop-control/ test/memory/` green.
- `cd packages/core && bun run typecheck` — 0 errors.
- `cd packages/tui && bun test test/display/ && bun run typecheck` — no new errors.
- `cd packages/opencode && bun run typecheck` — no new errors beyond ~35 pre-existing baseline.
- Self-review: W1 retry bounded + terminal-honoring; W3 stale reap works across restart; W4 delimiters neutralized; W2 per-provider isolation + probe reclaim; W6 write-only containment; W5 tiering + skill gate; W7 content search; W9 keyboard nav.
- Status doc: `docs/superpowers/plans/2026-08-12-loop-resilience-hardening.md` (this file) + status section.
- Final commit: `docs: loop resilience hardening complete status`.

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| W1 retry loop burns budget / doubles LLM spend | Bounded max 2 retries per drain, exponential backoff, only retryable reasons, terminal-state honored |
| W3 SQLite schema change breaks existing jobs | New table, additive; live in-memory fast-path preserved; reap only touches stale rows |
| W4 delimiter wrapping changes model-visible tool results | Allowlist trusted tools unchanged; tests lock framing for both classes |
| W2 breaker refactor breaks loop-control-host | Keep existing interface callable; default disabled = no-op; per-session construction preserved |
| W6 containment rejects legit symlink use | Scope to write paths only; verify no legit external-symlink write use |
| W5 skill scan false positives | context scope only; quarantine not delete; existing memory scans unchanged |
| W7 FTS5 vs LIKE | Prefer existing FTS infra if reachable; LIKE subquery acceptable v1 |
| W9 keybinding conflicts | Check existing keybind map; use free keys; mouse fold unaffected |
