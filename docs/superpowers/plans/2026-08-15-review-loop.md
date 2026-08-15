# Code Review Loop Implementation Plan (W8e)

> REQUIRED: subagent-driven-development or executing-plans.

**Goal:** Ship `docs/superpowers/specs/2026-08-15-review-loop-design.md`.

## Files

- `packages/core/src/tool/review.ts`
- `packages/core/src/session/review-gate.ts`
- `packages/core/src/plugin/command/review.txt` (already) — keep as child prompt
- `packages/core/test/review/*.test.ts`
- builtins + command registry if `/review` is not already wired to the tool

### Task 1: tool + parse

- [ ] `review` settles via Task.Host with explore + the template.
- [ ] Parse JSON from child output (fence-tolerant). Bad JSON → ToolFailure.
- [ ] Mock host returns known JSON → parent output verdict fail/pass.

### Task 2: gate

- [ ] `reviewGate` session flag; merge helper checks last review part.
- [ ] Test fail verdict blocks merge double. If W6 `WorktreeEngine.merge` is not merged yet, the test double **is** the gate — do not claim live merge blocking until W6 exists.
- [ ] Bad JSON is ToolFailure, never `verdict=pass`.

### Task 3

- [ ] `cd packages/core && bun test --timeout 60000 test/review/ test/runner/verifier.test.ts`

## Done

Spec 1–5. Reviewer: verifier untouched; bad JSON is not pass.

## Out

- Guardian
- Multi-file LLM in-process without task
