# Code Review Loop Design (W8e)

> Locked. Plan: `docs/superpowers/plans/2026-08-15-review-loop.md`.

**Goal:** A **code** review pass distinct from the loop-control verifier (which audits “I’m done” claims). Align Grok `/check-work` / Codex `/review`: isolated, structured findings, can fail a gate. **No Guardian auto-allow.**

**Proven:** `verifier.ts` = LLM `generateObject` on worker done-claim + optional diff; 8-reject cap. Not file-level review. `/review` command template exists in `plugin/command/review.txt` (prompt only).

## Rejected

- Replacing verifier with review (keep both).
- Mandatory second-model auto-approve of permissions (Guardian).
- Review that writes the tree (must be read-only or worktree).

## Product

1. **Command** `/review` (existing template) + tool `review` `{ scope?: "diff"|"paths", paths?: string[] }`.
2. Spawns `task` `subagent_type=explore` (read-only) or `isolation: worktree` if W6 exists; prompt = review.txt + `git diff` / listed files.
3. Child must return JSON:

```
{ "findings": [ { "file", "line?", "severity": "error"|"warning"|"note", "message" } ], "verdict": "pass"|"fail" }
```

4. Parent tool result is that JSON. `verdict=fail` if any `error`.
5. Optional session flag `reviewGate`: `SessionExecution` / merge HTTP refuses `WorktreeEngine.merge` when last review is fail. Default **off**. When on, merge/error is the gate — not a hidden permission bypass.

Slash `/review` admits a user message that instructs the primary to call `review` (don’t start a second drain type).

## Anti-fake

1. `review` tool in builtins.
2. Live with a dummy Task.Host: child sees “read-only” / explore agent; parent gets parsed findings.
3. Malformed child text → tool error, not `pass`.
4. Verifier tests still pass; review does not call `Verifier.audit`.
5. `reviewGate` on + fail findings → `WorktreeEngine.merge` (or a test double **until W6**) throws `ReviewGate.Failed`. Live merge blocking is not Done without W6.
