# Edit Match + Apply-Patch Move Design (W4)

> **Status:** locked for implementation. Pair with `docs/superpowers/plans/2026-08-15-edit-patch.md`.
> Final architecture. One match engine in core. One FileMutation.rename. No hashline, no second patch format, no atomic-rollback fiction.

**Goal:** Live V2 `edit` uses the same fuzzy match ladder V1 already ships, so indent/whitespace drift does not fail exact-only. Live `apply_patch` executes `*** Move to:` which `Patch.parse` already understands. Both stay on `LocationMutation` + `FileMutation` + `edit` permission.

**Proven in-tree (do not re-invent):**

| Fact | Where |
|---|---|
| V1 `replace()` ladder | `packages/opencode/src/tool/edit.ts` `SimpleReplacer` → `LineTrimmed` → `BlockAnchor` → `WhitespaceNormalized` → `IndentationFlexible` → `EscapeNormalized` → `TrimmedBoundary` → `ContextAware` → `MultiOccurrence`; unique match or throw; refuse disproportionate spans |
| V2 `edit` is exact `indexOf` only | `packages/core/src/tool/edit.ts` TODO + error “must match exactly, including whitespace and indentation” |
| Patch grammar already has moves | `Patch.Hunk.update.movePath` + `*** Move to:` in `packages/core/src/patch.ts` |
| Tool rejects moves before permission/IO | `apply-patch.ts` + test `rejects moves before applying any hunk` |
| `Patch.derive` already line-trims update hunks | `patch.test.ts` “derives fuzzy line updates while preserving BOM” |
| `FileMutation` has create/write/remove, **no rename** | `packages/core/src/file-mutation.ts` |

---

## 1. Why this is the product hole

Live drain settles core V2 tools. Models miss exact whitespace constantly. V1 already solved that; V2 threw it away. Models emit Codex-style `*** Move to:` and we hard-fail *before* any hunk, so a mixed add+move patch applies nothing.

Hashline (Grok) is a different edit language. Not W4.

---

## 2. Permanently rejected

| Idea | Why |
|---|---|
| Keep fuzzy only in V1 and “call V1 from V2” | Two engines. **Move** `replace` into core; V1 re-exports. |
| New match algorithm (hashline, LLM-corrector) | Unproven here. Port V1 ladder + tests. |
| Atomic rollback of a multi-hunk patch | Still not implemented. Sequential apply stays. Failures report what already landed. |
| Move via `bash mv` | Bypasses FileMutation locks and W1 `assertPath`. |
| Overwrite dest on move | Dest exists → fail, source unchanged. |
| “Move” as delete+add without `rename` API | Two writes, no lock pairing, dest can exist mid-way. Must be one `FileMutation.rename`. |

---

## 3. Edit match (one module)

`packages/core/src/tool/edit-match.ts` owns:

```
replace(content, oldString, newString, replaceAll): string
```

Semantics **identical** to V1 `replace` (same replacer order, same 0.65 thresholds, same `isDisproportionateMatch`).

V2 `edit` after BOM/line-ending normalize:

1. exact count as today if `indexOf` hits
2. else `edit-match.replace`
3. 0 matches → ToolFailure (message lists that exact **and** relaxed search failed)
4. >1 unique-search collision → same “provide more context / replaceAll” as V1

`replaceAll: true` only applies when the **chosen** search string is what `replaceAll` substitutes (V1 behavior).

V1 `packages/opencode/src/tool/edit.ts` deletes the local replacer bodies and imports core. After W4, `rg "function levenshtein" packages/` has **one** hit.

---

## 4. FileMutation.rename

```
rename({ from, to, expected? }): { from, to, resource }
```

- Lock **both** canonical paths (order by string to avoid deadlock).
- `to` must not exist (`TargetExistsError`).
- `from` must be a file.
- If `expected` given, `from` bytes must match (`StaleContentError`).
- Create dest dirs; `fs.rename` (same-filesystem). If `EXDEV`, copy bytes + unlink source under the same locks (still one API).
- W1 `assertPath(write)` on `to` if Sandbox exists; `from` is a write (unlink).

`apply_patch` and nobody else uses this in W4.

---

## 5. apply_patch move

Delete the early `moves are not supported yet` reject.

For each hunk, resolve **all** paths first (update path + `movePath`), then permission:

- `external_directory` for every external dest/source
- `action: "edit"` resources = union of source and dest resources

Then sequential apply:

| Hunk | Action |
|---|---|
| add | `create` (unchanged) |
| delete | `remove` (unchanged) |
| update, no move | `writeIfUnchanged` (unchanged) |
| update + movePath | `derive` content → writeIfUnchanged on **source** if bytes change → `rename` source→dest. If derive is identity, rename only. |

`Applied.type` adds `"move"`. `toModelOutput` prints `R old -> new`.

Dest exists at apply time → fail that hunk; earlier hunks stay (same partial-apply contract). The existing test that asserts add+move is a no-op **inverts**: both apply, `old.txt` gone, `moved.txt` has new content, `created.txt` exists.

Same-path `Move to:` (equal canonical) → treat as update only.

Move across Locations: dest `resolve(forWrite)` + external_directory if needed.

---

## 6. Patch.derive

Already fuzzy on hunk lines. W4 does **not** replace it with the edit ladder (different input: old/new line lists vs oldString). Leave derive as-is unless a test shows a real hole; do not “unify” algorithms.

---

## 7. Composition

- Permission still `edit`.
- W1 sandbox assert on every write/rename dest.
- No W2 (not a shell).

---

## 8. Definition of done (anti-fake)

1. File with 4-space indent, `oldString` 2-space same tokens → V2 edit succeeds (core test, no V1 import).
2. Two exact `foo` in file, `replaceAll` false → still error.
3. Block-anchor: first/last line match, middle 1 token drift, 5+ lines → succeeds; 2-line snippet does not use block-anchor.
4. Disproportionate match refused (V1 predicate, same numbers).
5. `rg "export const LineTrimmedReplacer"` → only `packages/core/src/tool/edit-match.ts`.
6. Patch with `*** Move to:` + content change: dest has new text, source absent, `applied` includes `move`.
7. Move to existing dest: error, source bytes unchanged.
8. Mixed add + move: both land (old reject-before-IO test deleted/inverted).
9. `FileMutation.rename` EXDEV-safe test if we can simulate; otherwise unit the fallback branch with a stub `fs.rename` error.

If (1) is implemented by mutating the test file to match exact indent, the test is illegal.
