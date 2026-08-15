# Compaction Tighten Design (W7)

> **Status:** locked. Pair: `docs/superpowers/plans/2026-08-15-compaction-tighten.md`.
> **Not a new recipe.** Continues `docs/superpowers/plans/2026-08-02-context-management-design.md`. PromptTape drop-on-compact stays.

**Goal:** Stop the step-based proactive compact that 08-02 already banned; trigger on tokens; persist a pre-compact checkpoint so compact is reversible as history, not a silent amnesia.

**Proven in-tree:**

| Fact | Where |
|---|---|
| v3 select + survival + MM `L·x/(x+K)` L=20k K=272k | `packages/core/src/session/compaction.ts` |
| Overflow recover exists | `runner/llm.ts` `compactAfterOverflow` |
| Proactive still **50% iteration budget + 30 steps** | `context-engine.ts` `PROACTIVE_COMPACT_RATIO`, `llm.ts` ~908 |
| 08-02 D? / “Task 10 禁用” | step trigger must go |
| Tape dropped on compact | keep-list |
| Memory flush on compact | keep-list |
| No `compaction_checkpoints/` | no dir |
| Snapshot service exists | `packages/core/src/snapshot.ts` (revert) |

---

## Rejected

| Idea | Why |
|---|---|
| Replace v3 with Grok intra/inter/full-replace | Second recipe. |
| Keep step trigger “as well” | 08-02 already called it wrong. |
| Checkpoint by rewriting tape in place only | Cannot restore. |
| Branch-summary trees (Pi `/tree`) | Separate session-tree product; not required to close 08-02. |

---

## Changes (final)

### 1. Trigger

`ContextEngine.shouldProactiveCompact` becomes **token-based**:

```
estimated_history_tokens + system/tools ≥ contextWindow − buffer
buffer = min(10% window, 20_000)   // 08-02 table
```

Inputs: last turn’s usage (if any) or `Token.estimate` on compiled tape / projected messages. **Do not** use iteration `consumed/cap`.

Delete `PROACTIVE_COMPACT_RATIO` and `MIN_STEPS_BETWEEN_PROACTIVE_COMPACT` from the live condition. A cooldown of **1 compact per drain** remains (already have overflow anti-recursion).

Manual compact unchanged. Overflow path unchanged.

### 2. Checkpoint

Before compact mutates history / drops tape:

- Write `session_compaction_checkpoint` (new table or JSON under session storage): `{ sessionID, epoch, seq, tape_json, message_ids[], created_at }`.
- Keep last **3** checkpoints per session (GC older).
- `SessionV2.uncompact({ sessionID, checkpointID? })` restores that snapshot (messages + tape) iff session not busy. Busy → `SessionBusyError`. Restore goes through message store + `PromptTapeStore`, **not** `SessionV2.prompt`.

Use existing message store + `PromptTapeStore`. Do not invent a third history.

### 3. Observability

Event already has compacting time. Add `SessionEvent.Compaction.Checkpoint { id }` and include token counts that triggered auto compact (for tests).

### 4. Predictability test

Same transcript fixture: official-style keep-last-8k vs our pack — we do **not** match official. We assert: trigger fired on token predicate; checkpoint exists; after compact tape is new epoch; uncompact restores previous tape hash.

---

## Anti-fake done

1. Unit: `shouldProactiveCompact` true when estimated tokens ≥ window−buffer **even if** steps consumed = 1.
2. Unit: `shouldProactiveCompact` false when tokens low **even if** steps consumed = 90% of cap.
3. Live/runner: compact writes a checkpoint row; `uncompact` restores `tape_json` equality.
4. `rg "PROACTIVE_COMPACT_RATIO|MIN_STEPS_BETWEEN_PROACTIVE_COMPACT" packages/core/src` → no matches.
5. Overflow + flush-on-compact tests still pass.

If (1)(2) still read `IterationBudget.remaining`, W7 is fake.
