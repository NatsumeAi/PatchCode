# Worktree Engine Implementation Plan (W6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans. Checkboxes required.

**Goal:** Ship `docs/superpowers/specs/2026-08-15-worktree-engine-design.md`.

**Architecture:** `WorktreeEngine` + **git backend only in this PR**. Probe may log overlay/btrfs/reflink; `acquire` must not select them. Task host uses acquire. Merge/discard/diff are first-class.

**Tech Stack:** TypeScript, Effect, git CLI (host), Bun test.

---

## Constraints

```bash
cd packages/core && bun test --timeout 60000 test/worktree-engine/
cd packages/opencode && bun test --timeout 180000 test/worktree-engine/
```

- Live tests need a real `git init` repo (see `packages/core/test/fixture/git.ts`).
- Do not require root/btrfs.
- Mark git spawns `// sandbox:host`.
- Do not commit unless asked.

## Files

| Path | Role |
|---|---|
| `packages/core/src/worktree-engine.ts` | service |
| `packages/core/src/worktree-engine/probe.ts` | backend detect |
| `packages/core/src/worktree-engine/git.ts` | required backend |
| `packages/core/src/session/worktree-pool.ts` | thin re-export of acquire/release |
| `packages/opencode/src/tool/tool-host-bridges.ts` | isolation uses engine |
| `packages/core/src/tool/worktree.ts` | merge/diff/discard tool |
| `packages/core/test/worktree-engine/*.test.ts` | proofs |

---

### Task 1: probe (log only)

- [ ] Test: `probe()` returns a member of `git|overlay|btrfs|reflink`. On this host expect `"git"`.
- [ ] Implement probes for logging. **`acquire` in this PR always calls `git.ts`.** If probe says overlay/btrfs/reflink, log `worktree.backend_unavailable` and still use git. Do not ship overlay mount / btrfs snapshot as a product path.
- [ ] `cd packages/core && bun test --timeout 60000 test/worktree-engine/probe.test.ts`

### Task 2: git acquire/release/pool

- [ ] Live: init repo, acquire id=a, file from HEAD exists in dir, parent unchanged.
- [ ] Second acquire id=b → different dir.
- [ ] release a then acquire c can reuse pool dir (dir path may be reused after reset).
- [ ] Implement `git.ts` as spec. Replace `worktree-pool.ts` body with engine calls.
- [ ] Run acquire tests.

### Task 3: previewDiff + merge + dirty parent

- [ ] Write in child only → previewDiff contains the path; parent file old.
- [ ] merge → parent new; no DirtyParent.
- [ ] Dirty parent same path → merge error; parent still dirty original.
- [ ] Implement merge via path checkout from worktree or `git apply`.
- [ ] Run merge tests.

### Task 4: task host + worktree tool

- [ ] `isolation: worktree` calls `WorktreeEngine.acquire`; child cwd is dir (extend existing task host test or add `test/worktree-engine/task-isolation.test.ts`).
- [ ] `worktree` tool: `diff|merge|discard` + id; permission `task`.
- [ ] Register in builtins.

### Task 5: inventory

- [ ] Fail if `worktree-pool.ts` still contains `git worktree add` instead of engine.
- [ ] Fail if task host isolation does not mention `WorktreeEngine`.
- [ ] `cd packages/core && bun test --timeout 60000 test/worktree-engine/`

## Done

Spec anti-fake 1–7 each have a test. Reviewer: child write does not touch parent until merge; dirty parent merge fails.

## Out

- Shipping overlay / btrfs / reflink as a selectable backend
- Shipping a Rust CoW crate
- Auto-merge on child complete
- Windows junctions (skip live on win32)
