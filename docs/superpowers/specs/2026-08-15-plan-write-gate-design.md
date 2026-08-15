# Plan Write Gate Design (W8b)

> Locked. Plan: `docs/superpowers/plans/2026-08-15-plan-write-gate.md`.

**Goal:** Plan mode is a **mutation gate**, not a prompt. Grok rejects non-`plan.md` writes even under always-approve. We already deny `edit` * for the plan agent except plan paths — **bash/`apply_patch` still have `* allow`**.

**Prerequisite:** W2 classify is on live `bash.ts`. Do not start W8b before that.

**Single source of truth:** `session.plan_mode`. `switchAgent("plan")` only **syncs** that flag. Bash/write gates **must not** read agent id.

**Proven:**

| Fact | Where |
|---|---|
| `plan` agent `edit *` deny + allow `.opencode/plans/*.md` and global plans | `plugin/agent.ts` |
| `write` asserts `action: "edit"` | `write.ts` — already gated |
| `apply_patch` asserts `edit` | gated if resources aren’t `*` only — it uses target resources |
| `bash` asserts `action: "bash"` | **not gated** |
| `plan_enter` only asks to switch agent | `plan-enter.ts` |
| `defaults` include `{ action: "*", resource: "*", effect: "allow" }` | bash remains allow |

## Rejected

- Prompt reminder as the gate.
- Gating only `edit`/`write` and leaving bash.
- Changing default `* allow` globally (W2 already punches catch-all for unknown bash prefixes; plan mode needs a **session flag**).

## Product

Session field `planMode: boolean` (column `plan_mode`). Set true on successful `plan_enter` (after user accepts). False on `plan_exit`. `switchAgent("plan")` sets it; `switchAgent` away from plan clears it. Gating code reads **only** this column.

`PlanGate.assertMutation({ sessionID, kind: "fs"|"bash", paths[] })`:

`PlanGate.assertMutation({ sessionID, kind: "fs"|"bash", paths[] })`:

- If session not planMode → no-op.
- `fs`: every path must match allowlist:
  - `<location>/.opencode/plans/**/*.md`
  - `Global.Path.data/plans/**/*.md`
- `bash`: **deny** unless classified (W2) as allowlisted read-only (`ls`, `pwd`, `git status`, `git diff`, `rg`, `cat` of allowlisted files). Any other bash — including `printf x > src/x.ts` — → `PlanGate.Denied` **before** spawn.
- `apply_patch` / `edit` / `write` call `fs` gate **in addition** to permission. `FileMutation` has **no** sessionID today — assert at tool/bash sites, do not pretend `FileMutation.rename` can see the session. W4 may add `rename`; the rename **caller** still passes sessionID into PlanGate.

`plan_enter` remains the UX to switch agent + set flag. Switching agent to `plan` without the tool (session.switchAgent) must also set the flag. Leaving plan clears it.

## Anti-fake

1. Plan-mode session: `write` `src/a.ts` → Denied; `src/a.ts` absent.
2. Plan-mode: `write` `.opencode/plans/foo.md` → ok.
3. Plan-mode: `bash` `echo x > src/a.ts` → Denied; file absent (not only permission on `edit`).
4. After `plan_exit`: `write` `src/a.ts` allowed (permission permitting).
5. `rg PlanGate packages/core/src/tool/bash.ts` hits.
