# Compaction Tighten Implementation Plan (W7)

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development or executing-plans.

**Goal:** Ship `docs/superpowers/specs/2026-08-15-compaction-tighten-design.md` without replacing v3 select/MM.

**Architecture:** Token predicate in `ContextEngine`; checkpoint table + `uncompact`; runner unchanged except the boolean it already reads.

---

## Constraints

```bash
cd packages/core && bun test --timeout 60000 test/session/compaction-budget.test.ts test/runner/context-engine.test.ts test/session-compaction.test.ts test/session/runner/prompt-tape*.ts
```

Live compact stays `packages/core/src/session/compaction.ts` (runner already calls it). Do not add a second `compaction.ts`. W5 Pre/PostCompact must fire on **this** entry when W5 exists; this PR only needs a stable function the hook can wrap.

## Files

| Path | Role |
|---|---|
| `packages/core/src/session/runner/context-engine.ts` | token trigger |
| `packages/core/src/session/compaction-checkpoint.ts` | persist/restore |
| `packages/core/src/database/migration/20260815200000_compaction_checkpoint.ts` | table |
| `packages/core/src/session.ts` | `uncompact` |
| `packages/core/src/session/compaction.ts` | write checkpoint at start |
| `packages/core/test/runner/context-engine.test.ts` | flip predicates |
| `packages/core/test/session/compaction-checkpoint.test.ts` | restore tape |

---

### Task 1: token trigger

- [ ] Rewrite `context-engine.test.ts`: inject `estimateTokens` + `contextWindow`; assert spec anti-fake 1–2.
- [ ] Change `Interface` to take token snapshot from runner (`setUsage({ tokens, window })` each turn). `shouldProactiveCompact` uses last snapshot vs `min(0.1*window, 20000)` buffer.
- [ ] `llm.ts` already calls `shouldProactiveCompact` — pass usage from last `compiled`/provider usage. If no usage yet, false.
- [ ] Delete step ratio constants.
- [ ] Run context-engine tests + `session-runner` compact rows if any.

### Task 2: checkpoint table + write

- [ ] Migration: `session_compaction_checkpoint (id, session_id, created_at, tape_json, message_ids_json)`.
- [ ] `compaction.ts` start: insert checkpoint (keep last 3).
- [ ] Test: compact path inserts one row.

### Task 3: uncompact

- [ ] `SessionV2.uncompact({ sessionID, checkpointID? })`: busy → SessionBusyError; restore messages + `PromptTapeStore` from checkpoint via the stores **directly**. **Forbidden:** calling `SessionV2.prompt` (that `terminal.reset`s loop abort). Drop newer checkpoint; new epoch consistent with tape restore.
- [ ] Test: tape hash before compact === after uncompact.
- [ ] Test: `/loop abort` then uncompact does not clear `user_abort`.
- [ ] Keep-list compact-drops-tape test still passes. Keep-list PromptTape tests still pass.

### Task 4: inventory

- [ ] `rg PROACTIVE_COMPACT_RATIO packages/core/src` empty.
- [ ] `cd packages/core && bun test --timeout 60000 test/runner/context-engine.test.ts test/session/compaction-checkpoint.test.ts test/session/compaction-budget.test.ts`

## Done

Spec anti-fake 1–5. Reviewer: low-step high-token triggers; high-step low-token does not.

## Out

- Pi branch summaries
- Grok intra/inter rewrite
- Changing MM L/K
