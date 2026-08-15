# repo_clone / repo_overview Design (W8f)

> Locked. Plan: `docs/superpowers/plans/2026-08-15-repo-tools.md`.

**Goal:** The two leaves already named in `builtins.ts` TODO. Clone is permissioned; overview is a bounded read-only digest so children don’t eat the whole tree.

**Proven:** `RepositoryCache.ensure` already clones/fetches remotes (`repository-cache.ts`). `Repository.parse` validates refs. No tools. Arbitrary `git clone` via bash is W1/W2’s problem; this tool is the supported path.

## Rejected

- Shelling out to `git clone` without going through `RepositoryCache` + permission.
- Cloning `file://` to escape Location (local file refs already have `UnsupportedLocalRepositoryError` — keep).
- Unlimited tree dump as overview.

## repo_clone

```
repo_clone({ repository, branch?, dest? })
```

- Parse with `Repository`. Only `https`/`ssh` git remotes (github/gitlab/generic host).
- Permission `bash` or new action `repo` — locked: **`repo`** action (so plan mode / catch-all can deny).
- Dest default: `Global.Path.repos/<host>/<owner>/<repo>` (cache) **or** Location-relative `dest` if provided (`LocationMutation` write + W1).
- Implementation: `RepositoryCache.ensure` then if `dest`, copy or worktree into dest (not a second clone implementation).
- SSRF: `Net.denyHost` (W1 `packages/core/src/net/deny-host.ts`). Literal loopback / link-local / metadata hosts fail **before** `RepositoryCache.ensure`.

## repo_overview

```
repo_overview({ path? })  // default Location
```

- Permission `read`.
- Output bounded (~8 KiB): top-level listing, README first 80 lines, language guess by extension counts (no new deps), HEAD sha if git.
- Uses `list_dir`/`read` internals, not bash.

## Anti-fake

1. Both names in `BuiltInTools`.
2. `repo_clone` `https://127.0.0.1/x.git` denied (no git spawn).
3. `repo_clone` uses `RepositoryCache.ensure` (`rg` in tool file).
4. overview of a tmp project with README + `.ts` files returns README snippet and `ts` count; output length < 16_384.
5. No `AppProcess` in `repo-overview.ts`.
