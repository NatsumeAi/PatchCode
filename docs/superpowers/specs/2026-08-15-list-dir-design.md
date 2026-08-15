# list_dir Design (W8a)

> Locked. Plan: `docs/superpowers/plans/2026-08-15-list-dir.md`.

**Goal:** A first-class `list_dir` tool so models stop using `bash ls` / overloading `read`.

**Proven:** `read` already lists directories via `ReadToolFileSystem.ListPage` (`read.ts` kind directory). There is **no** `list_dir` in `builtins.ts`. Grok/Codex ship `list_dir`.

## Rejected

- Implementing list by spawning `ls` (W1/W2 hole).
- Second directory walker (use `ReadToolFileSystem` / `FSUtil.readDirectoryEntries`).
- Removing directory mode from `read` in this program (compat). `list_dir` is the advertised tool; `read` on a dir still works.

## Product

```
list_dir({ path, offset?, limit? })
```

- Resolve via `LocationMutation` `kind: "directory"`.
- Permission `read`.
- W1 `assertPath("read")` if present.
- Output: `ListPage` (same schema as read): names, types, offset, next.
- Bounds: same `MAX` as read-filesystem directory page.
- Does not follow symlink out of Location without `external_directory`.
- Hidden files: include; do not implement gitignore unless `FSUtil` already does for this listing helper — match `read` dir behavior exactly.

Register in `BuiltInTools.node`.

## Anti-fake

1. `toolDefinitions` includes `list_dir`.
2. Live: tmp dir with `a.ts` + `sub/` → names include both; types file/directory.
3. External abs path: `external_directory` assert fired.
4. `list_dir.ts` does not import `AppProcess` / `spawn`.
5. Pagination: limit 1 → next offset works.
