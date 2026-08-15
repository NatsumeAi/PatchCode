# repo_clone / repo_overview Implementation Plan (W8f)

> REQUIRED: subagent-driven-development or executing-plans.

**Goal:** Ship `docs/superpowers/specs/2026-08-15-repo-tools-design.md`.

## Files

- `packages/core/src/tool/repo-clone.ts`, `repo-overview.ts`
- `builtins.ts` (remove TODO once done)
- `packages/core/test/tool-repo-clone.test.ts`, `tool-repo-overview.test.ts`

### Task 1: overview

- [ ] Live tmp tree; assert bound output + read permission.
- [ ] Implement with FSUtil only.

### Task 2: clone

- [ ] Mock `RepositoryCache.ensure`; assert called with parsed remote.
- [ ] Loopback / `169.254.169.254` URL fails via `Net.denyHost` before ensure.
- [ ] dest inside Location goes through `LocationMutation` write.
- [ ] Optional live: skip unless `OPENCODE_TEST_GIT_CLONE=1`.

### Task 3

- [ ] `cd packages/core && bun test --timeout 60000 test/tool-repo-overview.test.ts test/tool-repo-clone.test.ts`

## Done

Spec 1–5. Reviewer: loopback clone never spawns git.

## Out

- Git LFS
- Sparse checkout UI
