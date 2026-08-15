# Edit Match + Apply-Patch Move Implementation Plan (W4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `docs/superpowers/specs/2026-08-15-edit-patch-design.md`: one core `edit-match.replace`, V2 edit uses it, V1 re-exports it, `apply_patch` executes `*** Move to:` via `FileMutation.rename`.

**Architecture:** Move V1 replacer ladder verbatim into `packages/core/src/tool/edit-match.ts`. Add `FileMutation.rename` (**does not exist today** — lock both paths, dest must not exist, EXDEV fallback). Remove the apply-patch early move reject; invert the existing live test.

**Tech Stack:** TypeScript, Effect, Bun test, existing `diff` + `Patch.parse` / `Patch.derive`.

**Contract:** the spec. No hashline. No atomic rollback. No `bash mv`.

---

## Global constraints

```bash
cd packages/core && bun test --timeout 60000 <files>
cd packages/opencode && bun test --timeout 180000 <files>
```

- No `LIVE_CACHE`, no `auth.json`.
- Port V1 `replace` **byte-for-byte** (thresholds 0.65, replacer order, `isDisproportionateMatch`). Do not “improve” the ladder in this plan.
- Do not commit unless the user asks.
- Keep-list / W1–W3 files untouched except calling `assertPath` on rename dest **if** `Sandbox` is already imported in FileMutation (if W1 not merged, skip that call).

---

## File map

| Path | Role |
|---|---|
| `packages/core/src/tool/edit-match.ts` | `replace` + all Replacers |
| `packages/core/src/tool/edit.ts` | call `replace` after exact miss |
| `packages/opencode/src/tool/edit.ts` | delete local replacers; `export { replace, ... } from "@opencode-ai/core/tool/edit-match"` |
| `packages/core/src/file-mutation.ts` | `rename` |
| `packages/core/src/tool/apply-patch.ts` | apply move; `Applied.type` includes `move` |
| `packages/core/test/edit-match.test.ts` | ladder fixtures |
| `packages/core/test/tool-edit.test.ts` | extend existing |
| `packages/core/test/file-mutation.test.ts` | rename dest-exists / happy |
| `packages/core/test/tool-apply-patch.test.ts` | invert move test |
| `packages/core/test/edit-match-inventory.test.ts` | one levenshtein |

---

### Task 1: Port `replace` to core with V1 fixtures

**Files:**
- Create: `packages/core/src/tool/edit-match.ts`
- Create: `packages/core/test/edit-match.test.ts`

Copy functions from `packages/opencode/src/tool/edit.ts` lines 217–737 (`Replacer` type through `replace` / `isDisproportionateMatch`). Also copy `trimDiff` only if something imports it from edit.ts for tests; otherwise leave `trimDiff` in V1 until grepped.

- [ ] **Step 1: Write fixtures first** (these are the anti-fake cases)

```ts
import { describe, expect, test } from "bun:test"
import { replace } from "../src/tool/edit-match"

test("exact still wins", () => {
  expect(replace("a b a", "b", "c")).toBe("a c a")
})

test("indent-only mismatch matches the file indent", () => {
  const file = "function f() {\n    return 1\n}\n"
  const old = "function f() {\n  return 1\n}"
  expect(replace(file, old, "function f() {\n    return 2\n}")).toBe("function f() {\n    return 2\n}\n")
})

test("two exact hits without replaceAll throw", () => {
  expect(() => replace("aa x aa", "aa", "bb")).toThrow(/multiple/i)
})

test("replaceAll replaces the matched search", () => {
  expect(replace("aa x aa", "aa", "bb", true)).toBe("bb x bb")
})

test("empty oldString throws", () => {
  expect(() => replace("x", "", "y")).toThrow(/empty/i)
})

test("identical old/new throws", () => {
  expect(() => replace("x", "x", "x")).toThrow(/identical/i)
})
```

Add one block-anchor case (≥3 lines, first/last match, middle token drift) that V1 accepts, and one 2-line case that must **not** silently rewrite a distant function.

- [ ] **Step 2: Run — FAIL** (`Cannot find module`)

```bash
cd packages/core && bun test --timeout 60000 test/edit-match.test.ts
```

- [ ] **Step 3: Paste V1 ladder into `edit-match.ts`. Do not retype algorithms.**

- [ ] **Step 4: Run — PASS.**

---

### Task 2: V2 edit uses `edit-match`

**Files:**
- Modify: `packages/core/src/tool/edit.ts`
- Modify: `packages/core/test/tool-edit.test.ts`

Replace the exact-only failure when `replacements === 0`:

```ts
let next = source.text
let replacements = countOccurrences(source.text, oldString)
if (replacements === 0) {
  next = yield* Effect.try({
    try: () => EditMatch.replace(source.text, oldString, newString, input.replaceAll === true),
    catch: (cause) => new ToolFailure({ message: String(cause instanceof Error ? cause.message : cause) }),
  })
  replacements = 1
} else if (replacements > 1 && input.replaceAll !== true) {
  return yield* new ToolFailure({ message: "Found multiple exact matches..." })
} else {
  next = input.replaceAll === true ? source.text.replaceAll(oldString, newString) : source.text.replace(oldString, newString)
}
```

Keep BOM / line-ending conversion **before** match (already there).

- [ ] **Step 1: Add a live tool-edit test** (same `withTool` harness as `tool-edit.test.ts`): write a 4-space file, call edit with 2-space `oldString`, expect file has new text.

- [ ] **Step 2: Implement.** Existing exact tests must still pass.

- [ ] **Step 3:**

```bash
cd packages/core && bun test --timeout 60000 test/tool-edit.test.ts test/edit-match.test.ts
```

---

### Task 3: V1 re-exports core (one ladder)

**Files:**
- Modify: `packages/opencode/src/tool/edit.ts`

Delete local `Replacer` implementations and `replace`. Re-export:

```ts
export {
  replace,
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
  ContextAwareReplacer,
  MultiOccurrenceReplacer,
  trimDiff, // if still referenced
} from "@opencode-ai/core/tool/edit-match"
```

If `trimDiff` stays V1-only and unused by core, keep it in V1 **or** move it with the rest.

- [ ] **Step 1:** `rg "function levenshtein" packages` → only `edit-match.ts`.

- [ ] **Step 2: Create `packages/core/test/edit-match-inventory.test.ts`** that fails if `levenshtein` appears in another `packages/**/*.ts` file.

- [ ] **Step 3:** If opencode has edit unit tests, run them from `packages/opencode`. Do not run the full prompt suite.

---

### Task 4: `FileMutation.rename`

**Files:**
- Modify: `packages/core/src/file-mutation.ts`
- Modify: `packages/core/test/file-mutation.test.ts` (or create if rename cases missing)

```ts
export interface RenameInput {
  readonly from: Target
  readonly to: Target
  readonly expected?: Uint8Array
}
export interface RenameResult {
  readonly operation: "rename"
  readonly from: string
  readonly to: string
  readonly resource: string
}
```

Lock order: `from.canonical < to.canonical` first, then the other.

- dest exists → `TargetExistsError`, do not touch source
- missing source → FS error
- `expected` mismatch → `StaleContentError`
- success: dest has bytes, source absent

- [ ] **Step 1: Tests for happy path, dest exists, stale expected.**

- [ ] **Step 2: Implement. EXDEV: read from + write to + remove from, still under both locks.**

- [ ] **Step 3: Run file-mutation tests.**

---

### Task 5: apply_patch executes moves

**Files:**
- Modify: `packages/core/src/tool/apply-patch.ts`
- Modify: `packages/core/test/tool-apply-patch.test.ts`

- [ ] **Step 1: Invert `rejects moves before applying any hunk`**

Same patch as today’s test:

```
*** Begin Patch
*** Add File: created.txt
+created
*** Update File: old.txt
*** Move to: moved.txt
@@
-before
+after
*** End Patch
```

Expect: success; `created.txt` exists; `old.txt` absent; `moved.txt` is `after\n`; `applied` contains add + move; permission `edit` resources include both `old.txt` and `moved.txt`.

Add: move to existing dest fails; `old.txt` unchanged.

Add: move-only (oldLines/newLines identity) still renames.

- [ ] **Step 2: Implement**

1. Delete the `if (move) return ToolFailure("…not supported yet")` block.
2. When collecting targets, also `mutation.resolve({ path: hunk.movePath, kind: "file", forWrite: true })`.
3. Permission resources = all targets.
4. On apply, after content writeIfUnchanged (if changed), `files.rename({ from: sourceTarget, to: destTarget, expected })`.
5. `Applied.type` union adds `"move"`. `toModelOutput`: `R ${from} -> ${to}`.
6. Description string: remove “Moves … are not supported yet.”

- [ ] **Step 3:**

```bash
cd packages/core && bun test --timeout 60000 test/tool-apply-patch.test.ts test/patch.test.ts test/file-mutation.test.ts
```

Update any assertion that expected the old error string.

---

### Task 6: Inventory + full W4 suite

**Files:**
- `packages/core/test/edit-match-inventory.test.ts` (Task 3)

Also fail if `apply-patch.ts` still contains `moves are not supported yet`.

- [ ] **Step 1:**

```bash
cd packages/core && bun test --timeout 60000 test/edit-match.test.ts test/edit-match-inventory.test.ts test/tool-edit.test.ts test/tool-apply-patch.test.ts test/file-mutation.test.ts test/patch.test.ts
```

Expected: all pass. Indent fixture is the live file content, not pre-normalized.

---

## Definition of done

Spec §8 items 1–9 map to tests. Reviewer: `rg levenshtein packages` one file; move live test creates `moved.txt` and deletes `old.txt`.

---

## Out of scope

- Hashline
- Atomic multi-hunk rollback
- Formatter / LSP notify TODOs still on V2 edit
- Replacing `Patch.derive` with the edit ladder
