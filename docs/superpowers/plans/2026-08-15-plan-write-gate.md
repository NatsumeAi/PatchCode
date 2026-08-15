# Plan Write Gate Implementation Plan (W8b)

> REQUIRED: subagent-driven-development or executing-plans.

**Goal:** Ship `docs/superpowers/specs/2026-08-15-plan-write-gate-design.md`.

**Prerequisite:** W2 on live `bash.ts`. Gate reads `session.plan_mode` only.

## Files

| Path | Role |
|---|---|
| `packages/core/src/session/plan-gate.ts` | allowlist + assert |
| `packages/schema/src/session.ts` + sql | `plan_mode` column default 0 |
| `packages/core/src/tool/plan-enter.ts` / `plan-exit.ts` | set/clear flag + switch agent |
| `packages/core/src/session.ts` switchAgent | sync flag with agent id `plan` |
| `packages/core/src/tool/bash.ts` | PlanGate after W2 decide, before spawn |
| `packages/core/src/tool/write.ts` / `edit.ts` / `apply-patch.ts` | fs gate (FileMutation has no sessionID) |
| `packages/core/test/plan-gate/*.test.ts` | proofs |

### Task 1: flag + allowlist

- [ ] Migration `plan_mode integer not null default 0`.
- [ ] Tests: `isPlanPath` true only for the two trees.
- [ ] Implement `PlanGate`.

### Task 2: enter/exit/switchAgent

- [ ] plan_enter accept → agent plan + plan_mode 1.
- [ ] plan_exit → agent build + plan_mode 0.
- [ ] switchAgent("plan") sets flag; switchAgent("build") clears.
- [ ] Test: session with agent `plan` but `plan_mode=0` (corrupt) → write `src/` **allowed by PlanGate** (permission may still deny). Gate follows the column, not the agent id.
- [ ] Test: agent `build` + `plan_mode=1` → write `src/` denied.

### Task 3: mutation sites

- [ ] Live: plan session write `src/x.ts` fails, file missing; write plan md ok.
- [ ] Live: bash `printf x > src/x.ts` fails, file missing.
- [ ] FileMutation.write is **not** the PlanGate site (no sessionID). Call from write/edit/apply-patch/bash (and rename callers). Locked: bash + write + edit + apply-patch + rename callers.

### Task 4: inventory

- [ ] `rg PlanGate packages/core/src/tool/bash.ts` hits.
- [ ] `cd packages/core && bun test --timeout 60000 test/plan-gate/ test/tool-write.test.ts test/tool-edit.test.ts`

## Done

Spec 1–5. Reviewer: bash cannot write src in plan mode.

## Out

- Redesigning plan_enter UX copy
- Denying read in plan mode
