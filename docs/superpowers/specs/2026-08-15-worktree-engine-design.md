# Worktree Engine Design (W6)

> **Status:** locked. Pair: `docs/superpowers/plans/2026-08-15-worktree-engine.md`.
> Final form. One `WorktreeEngine`. Fast backends are probes, not a second product. This host is **ext4**: no btrfs, `cp --reflink=always` fails, overlay mount needs root. **Git worktree is the only backend that must pass CI here.**

**Goal:** `task isolation: worktree` uses a pool + preview/merge/discard, not a one-shot `git worktree add --detach` with no way back.

**Proven:**

| Probe (2026-08-15, this host) | Result |
|---|---|
| `findmnt` `/home` | ext4 |
| `cp --reflink=always` | `不支持的操作` |
| `mount -t overlay` | `必须以超级用户身份使用 mount` |
| `git worktree add --detach` | works |

Current `worktree-pool.ts`: add + force remove only. No pool reuse, no diff, no merge. `task.ts` `isolation: worktree` calls this.

---

## Rejected

| Idea | Why |
|---|---|
| Require btrfs/overlay to ship | Unexecutable on this CI host. |
| Two APIs (fast vs git) | One `WorktreeEngine`. |
| Silent merge onto dirty parent | Must fail or 3-way with conflict report. |
| Isolation without merge/discard | Not a product (today). |

---

## API

```
WorktreeEngine.Service
  probe(): BackendName          // "git" | "overlay" | "btrfs" | "reflink"
  acquire({ projectRoot, id, ref? }): { dir, backend, id }
  previewDiff(id): unified diff vs parent HEAD (or vs acquire snapshot)
  merge(id): apply to parent working tree; fail if parent dirty on overlapping paths
  discard(id): release
  gc(): remove orphans under .opencode/worktrees
```

**Backend selection in this PR:** always **git worktree**. `probe()` may detect btrfs/overlay/reflink and log them. `acquire` **must not** call those backends until a later PR implements and live-tests them. Failed probe ≠ crash.

Do not ship overlay/btrfs as a product just because the probe enum exists.

**Git backend (required, tested):**

- Pool: keep up to `N=2` warm worktrees per repo under `.opencode/worktrees/pool-*`.
- `acquire`: take warm or `git worktree add --detach`; `git reset --hard <ref>`; `git clean -fdx` (respecting no force-delete of the pool lock).
- `release`: reset --hard + clean, return to pool if pool < N, else `worktree remove --force`.
- `previewDiff`: `git -C dir diff --no-ext-diff HEAD` plus untracked as new files.
- `merge`: if parent `git status --porcelain` overlaps dest paths → `Worktree.DirtyParent`. Else `git -C parent apply` the diff or checkout files from worktree by path. No implicit `git merge` of a detached HEAD onto a dirty tree.
- `// sandbox:host` on git spawns (W1 inventory).

**Fast backends (later PR, not this one):** same directory layout and merge rules; only `acquire` copies faster. This PR skips them. Tests that need overlay must not be required for Done.

**Task host:** `isolation: worktree` → `acquire` → child Location.directory = `dir` → on Complete offer merge is **not** automatic. Child result includes `worktreeId`. Parent (or user) calls `WorktreeEngine.merge` via HTTP `POST /session/:id/worktrees/:wid/merge` or a `worktree` tool `{action: merge|discard|diff, id}`.

Cap: 4 live isolated children per project.

---

## Anti-fake done

1. acquire two children → two dirs, files from HEAD present; parent working tree unchanged.
2. write in child → previewDiff non-empty; parent file unchanged.
3. merge clean parent → parent file updated; child discarded or still listed.
4. dirty parent same path → merge fails, parent bytes unchanged.
5. `probe()` on this host returns `"git"` (or logs a faster name **and still acquires via git**). Overlay-only tests are **out of this PR**.
6. `worktree-pool.ts` either deleted or is a 3-line wrapper around Engine (no second add/remove).
7. Inventory: `task` isolation path calls `WorktreeEngine.acquire`, not raw `git worktree add`.
