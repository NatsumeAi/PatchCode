# Memory System P5 Implementation Plan (Prune + /memory UI + /remember Review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. P1–P4 must be complete — this consumes `MemoryRoots`/`readTextSafe`/`writeTextAtomic`/`scanForThreats`/`add_note` internals, and the P4 `access_count` column.

**Goal:** Add memory quality tooling and a TUI surface: usage-based pruning of curated memory at **chunk/entry** granularity, a `/memory` browse modal (list files, preview, delete session logs only), and a `/remember` review panel as **UX confirmation** (not a security boundary — agent/CLI still gated only by `memory_add_note` tool description). Follows P4–P6 phase order (P6 = auto-recall; P7 = vector).

**Architecture:** Prune is a pure function over the P4 index (`access_count` per **chunk id**, with real `mtimeMs`) — chunks below access threshold and older than age threshold are listed for LLM-confirmed removal in consolidation (never auto-delete curated text without merge output). Candidates are `chunkId` + excerpt, **not** whole-file paths like bare `MEMORY.md`. The TUI `/remember` dialog confirms user-initiated saves; it does **not** intercept arbitrary agent tool calls — document that clearly so implementers do not treat UI as the write gate.

**Tech Stack:** TypeScript, Effect, opencode TUI (`useCommandShortcut`, `DialogConfirm`/`DialogSelect`, `sessionCommandList`), bun:test + `testEffect` (core) + TUI test pattern from `packages/tui/test/display/`.

## Global Constraints

- Repo: `/home/huyongjun/openpartner/opencode` (branch `fork-runtime-loop-f720490219`).
- Core logic under `packages/core/src/memory/`; TUI under `packages/tui/src/` + tests `packages/tui/test/`.
- Same style/Effect rules as P1–P4. No `as any`, no `@ts-ignore`.
- Prune invariant: curated entries are never auto-deleted; removal requires LLM-confirmed consolidation output (a "prune list" of **chunk ids / excerpts**) and is reversible (content is in git for workspace memory).
- UI invariant: the TUI adds NO second write path and is **not** a security gate for agent tool calls; `/remember` confirms user-initiated note text then calls `memory_add_note`. Decline = no write.
- Typecheck gates: `bun --cwd packages/core typecheck` AND `bun --cwd packages/tui typecheck` clean.
- Commit per task. Execution Discipline from P1 applies.

---

## File Structure

```
packages/core/src/memory/
├── prune.ts             # prune candidates from index access counts + archive scan (pure, unit-testable)
├── (modify) merge-prompt.ts  # PRUNE_SYSTEM prompt fragment
└── (modify) tools.ts    # memory_add_note gains optional "confirm" flow hook (no behavior change by default)
packages/core/test/memory/
└── prune.test.ts
packages/tui/src/
├── memory-modal.tsx     # /memory browse modal (list + preview + delete session logs)
├── remember-dialog.tsx  # /remember confirmation wrapper (gates add_note)
└── (modify) routes/session/index.tsx  # register commands in sessionCommandList
packages/tui/test/
├── memory-modal.test.tsx
└── remember-dialog.test.tsx
```

---

### Task 1: Prune selection (pure)

**Files:**
- Create: `packages/core/src/memory/prune.ts`
- Test: `packages/core/test/memory/prune.test.ts`

**Interfaces:**
- Produces:
  - `export const PRUNE_ACCESS_THRESHOLD = 3` (access count below → prune candidate)
  - `export const PRUNE_AGE_DAYS = 90` (mtime older → prune candidate)
  - `export function selectPruneCandidates(input: Array<{ chunkId: string; path: string; excerpt: string; accessCount: number; mtimeMs: number }>, now: number): Array<{ chunkId: string; path: string; excerpt: string }>` — chunks where `accessCount < PRUNE_ACCESS_THRESHOLD` AND age > `PRUNE_AGE_DAYS`. **Never return a bare archive path without chunkId** (avoids whole-`MEMORY.md` prune).
  - `export const PRUNE_SYSTEM` prompt fragment (additive to PHASE2_SYSTEM): "Additionally, remove the listed chunk excerpts that are no longer relevant. Keep the archive coherent. Do not delete unrelated sections."

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/prune.test.ts
import { describe, expect, test } from "bun:test"
import { selectPruneCandidates, PRUNE_ACCESS_THRESHOLD, PRUNE_AGE_DAYS, PRUNE_SYSTEM } from "../../src/memory/prune"

const now = Date.parse("2026-08-07T00:00:00Z")
const old = now - (PRUNE_AGE_DAYS + 1) * 24 * 60 * 60 * 1000
const fresh = now - 1000

describe("Memory prune", () => {
  test("thresholds are sane", () => {
    expect(PRUNE_ACCESS_THRESHOLD).toBe(3)
    expect(PRUNE_AGE_DAYS).toBe(90)
  })

  test("selects old low-access chunks only (by chunkId)", () => {
    const selected = selectPruneCandidates(
      [
        { chunkId: "c1", path: "MEMORY.md", excerpt: "old entry here", accessCount: 0, mtimeMs: old },
        { chunkId: "c2", path: "sessions/a.md", excerpt: "hot", accessCount: 10, mtimeMs: old },
        { chunkId: "c3", path: "MEMORY.md", excerpt: "fresh", accessCount: 1, mtimeMs: fresh },
      ],
      now,
    )
    expect(selected).toEqual([{ chunkId: "c1", path: "MEMORY.md", excerpt: "old entry here" }])
  })

  test("PRUNE_SYSTEM mentions removal", () => {
    expect(PRUNE_SYSTEM.toLowerCase()).toContain("remove")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/prune.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/prune.ts
export const PRUNE_ACCESS_THRESHOLD = 3
export const PRUNE_AGE_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export function selectPruneCandidates(
  input: Array<{ chunkId: string; path: string; excerpt: string; accessCount: number; mtimeMs: number }>,
  now: number,
): Array<{ chunkId: string; path: string; excerpt: string }> {
  return input
    .filter((item) => item.accessCount < PRUNE_ACCESS_THRESHOLD && now - item.mtimeMs > PRUNE_AGE_DAYS * DAY_MS)
    .map(({ chunkId, path, excerpt }) => ({ chunkId, path, excerpt }))
}

export const PRUNE_SYSTEM =
  "Additionally, remove the listed chunk excerpts that are no longer relevant. Keep the archive coherent and up to date. Do not delete unrelated sections."
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/prune.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/prune.ts packages/core/test/memory/prune.test.ts
git commit -m "feat(memory): usage-based prune candidate selection"
```

---

### Task 2: Prune pass into consolidation

**Files:**
- Modify: `packages/core/src/memory/consolidate.ts` (prune step before phase2 merge)
- Modify: `packages/core/src/memory/index.ts` (export prune)
- Test: extend `packages/core/test/memory/consolidate.test.ts`

**Interfaces:**
- Consumes: Task 1 `selectPruneCandidates`, P4 index access counts (via a `listChunkAccess` handle method — add to `MemoryIndex` if missing), P3 merge pipeline

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/consolidate.test.ts — append
it.effect("consolidation includes prune list in merge prompt", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    await using dir = await tmpdir()
    const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
    yield* writeTextAtomic(fs, path.join(roots.globalDir, "MEMORY.md"), "old entry here")
    yield* writeTextAtomic(fs, path.join(roots.globalDir, "extensions/ad_hoc/notes/old-note.md"), "old note")
    // index seeded with a stale zero-access chunk for MEMORY.md
    yield* runConsolidation({ roots, llm: yield* LLMClient.Service })
    // assert the merge request message included the prune list (inspect via a capturing llm mock)
    expect(capturedUserMessage).toContain("remove")
  }),
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/consolidate.test.ts`
Expected: FAIL — prune list not in merge request (capturing mock shows no "remove" instruction).

- [ ] **Step 3: Wire prune into consolidate**

```ts
// packages/core/src/memory/consolidate.ts — inside runConsolidation, before phase2 merge
const prunePaths = yield* listChunkAccess(fs, roots).pipe(
  Effect.map((rows) => selectPruneCandidates(rows, Date.now())),
  Effect.catch(() => Effect.succeed([] as Array<{ chunkId: string; path: string; excerpt: string }>)),
)
// ... append to merge user message:
const pruneSection =
  prunePaths.length > 0
    ? `\n\nPRUNE LIST (chunk excerpts):\n${prunePaths.map((p) => `- ${p.chunkId} (${p.path}): ${p.excerpt}`).join("\n")}\n`
    : ""
// ... and append PRUNE_SYSTEM to PHASE2_SYSTEM in the merge system prompt
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/consolidate.test.ts test/memory/prune.test.ts`
Expected: PASS. Ensure `listChunkAccess` exists on the P4 `MemoryIndex` handle; if it does not, add it (Task 2 Step 4 — adding a read method to the index is additive, not a scope cut).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/consolidate.ts packages/core/src/memory/prune.ts packages/core/test/memory/consolidate.test.ts
git commit -m "feat(memory): prune candidates flow into consolidation merge prompt"
```

---

### Task 3: /memory browse modal (TUI)

**Files:**
- Create: `packages/tui/src/memory-modal.tsx`
- Modify: `packages/tui/src/routes/session/index.tsx` (register command "session.memory.browse")
- Test: `packages/tui/test/memory-modal.test.tsx`

**Interfaces:**
- Consumes: `useDialog`/`DialogSelect`-style modal API (read `packages/tui/src/routes/session/dialog-subagent.tsx` + `packages/tui/src/ui/dialog-select.tsx` for the exact pattern), `useSync`/`useProject` for paths, memory tool API (SDK `session` command surface or direct core call)
- Produces: `export function MemoryModal(props: { onClose: () => void })` — lists memory files grouped (workspace/global/sessions), previews selected file (read-only), delete only for `sessions/` files (with `DialogConfirm`), Esc closes; a `memory.browse` command in `sessionCommandList`

- [ ] **Step 1: Write the failing test**

```ts
// packages/tui/test/memory-modal.test.tsx
import { describe, expect, test } from "bun:test"
// Follow the compaction-entry.test.tsx render pattern: testRender + ThemeProvider + TuiConfigProvider
import { testRender } from "@opentui/solid"
import { MemoryModal } from "../src/memory-modal"

describe("MemoryModal", () => {
  test("renders a title and the memory file list", async () => {
    const { renderer } = await testRender(() => <MemoryModal onClose={() => {}} />, { width: 80, height: 24 })
    try {
      await new Promise((r) => setTimeout(r, 50))
      // assert a frame containing "Memory" and at least one file entry (fixture-backed)
    } finally {
      renderer.destroy()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory-modal.test.tsx`
Expected: FAIL — module not found / frame lacks "Memory".

- [ ] **Step 3: Write minimal implementation**

Follow the exact modal pattern from `dialog-subagent.tsx` (DialogSelect) or a custom `box`-based modal if selection is list+preview (two-pane). Implement:
- file list: call the memory tools via the plugin/command surface (or direct `Memory` core import in the TUI is NOT allowed — TUI must go through the SDK/command layer; read how other session commands call SDK APIs in `index.tsx`).
- preview: read-only text of selected file.
- delete: only `sessions/` paths, `DialogConfirm` before delete.
- close: Esc.

If the SDK has no memory surface yet, add a minimal `experimental.memory` HTTP surface in `packages/opencode` (list/read/delete-session-log) OR reuse the core `Memory` module via a small server handler — **decide by reading how `experimental` handlers are registered** (`packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts`) and mirror that. This is the largest discovery-risk item in P5; the modal itself stays thin.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory-modal.test.tsx`
Expected: PASS. Typecheck `bun --cwd packages/tui typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/memory-modal.tsx packages/tui/test/memory-modal.test.tsx packages/tui/src/routes/session/index.tsx
git commit -m "feat(tui): /memory browse modal with preview and session-log deletion"
```

---

### Task 4: /remember confirmation gate (TUI)

**Files:**
- Create: `packages/tui/src/remember-dialog.tsx`
- Modify: `packages/tui/src/routes/session/index.tsx` (register "session.memory.remember" command)
- Test: `packages/tui/test/remember-dialog.test.tsx`

**Interfaces:**
- Consumes: `DialogConfirm`-style confirm, memory tool write path
- Produces: `export function RememberDialog(props: { note: string; onConfirm: () => void; onCancel: () => void })` — shows note text with a "Save to memory?" confirmation; Confirm → calls the memory add-note path; Cancel → no write. The command flow: user types `/remember <text>` (or the model proposes a note), the dialog gates it, then the existing `memory_add_note` tool executes.

- [ ] **Step 1: Write the failing test**

```ts
// packages/tui/test/remember-dialog.test.tsx
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RememberDialog } from "../src/remember-dialog"

describe("RememberDialog", () => {
  test("confirm triggers onConfirm, cancel does not", async () => {
    let confirmed = 0
    let cancelled = 0
    const { renderer, mockMouse } = await testRender(
      () => <RememberDialog note="remember x" onConfirm={() => confirmed++} onCancel={() => cancelled++} />,
      { width: 80, height: 24 },
    )
    try {
      await new Promise((r) => setTimeout(r, 50))
      // click confirm → confirmed === 1
      // click cancel → cancelled === 1
    } finally {
      renderer.destroy()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/remember-dialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Follow `DialogConfirm.show` pattern from `index.tsx:628` (`DialogConfirm.show(dialog, title, message)` returning a boolean). The dialog shows the note and the memory write happens only after Confirm returns true; the note text is the one the user supplied via `/remember` (no second LLM rewrite in P5 — the Grok "rewritten version" toggle is deferred, documented).

**Gate clarity (architecture):** `/remember` is UX for user-initiated saves. It does **not** wrap or block the agent calling `memory_add_note` directly — that remains description-gated only (P1). Do not invent a core hook that rejects all unconfirmed tool writes unless a future phase explicitly adds it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/remember-dialog.test.tsx`
Expected: PASS. Typecheck `bun --cwd packages/tui typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/remember-dialog.tsx packages/tui/test/remember-dialog.test.tsx packages/tui/src/routes/session/index.tsx
git commit -m "feat(tui): /remember confirmation gate before memory note write"
```

---

### Task 5: Wiring gate + full-suite verification

**Files:**
- Verify-only (no new files): wiring greps + full test suites + typechecks

- [ ] **Step 1: Run the wiring gate**

```bash
grep -n "session.memory.browse" packages/tui/src/routes/session/index.tsx    # MUST match
grep -n "session.memory.remember" packages/tui/src/routes/session/index.tsx  # MUST match
grep -n "selectPruneCandidates" packages/core/src/memory/consolidate.ts      # MUST match
grep -n "listChunkAccess" packages/core/src/memory/reindex.ts                # MUST match
bun test test/memory/            # MUST pass (core, from packages/core)
bun test test/memory-modal.test.tsx test/remember-dialog.test.tsx            # MUST pass (from packages/tui)
bun --cwd packages/core typecheck
bun --cwd packages/tui typecheck
```

- [ ] **Step 2: Update the .gitignore template**

Extend `docs/memory/.gitignore.example` (from P1) with:
```gitignore
!index.sqlite   # NO — index is derived; keep it ignored:
index.sqlite
```

- [ ] **Step 3: Commit**

```bash
git add docs/memory/.gitignore.example
git commit -m "docs(memory): ignore derived index in project gitignore template"
```

---

## Self-Review

**Spec coverage (architecture doc P5):** chunk-level usage-based prune → Tasks 1–2; /memory browse → Task 3; /remember UX confirmation (not security gate) → Task 4; budget enforcement on merge → P3 already caps MEMORY.md; prune reversibility (git for workspace) documented; deferred: LLM-rewrite toggle in /remember (documented, not silent).

**Placeholder scan:** no TBD/TODO; test code concrete; one flagged discovery-risk item (Task 3 Step 3: TUI must reach memory through SDK/command layer — mirror `experimental.ts` handler pattern; the fallback is a thin `experimental.memory` HTTP surface, decided at implementation time, not silently skipped).

**Type consistency:** `selectPruneCandidates`/`PRUNE_SYSTEM` (Task 1) consumed by Task 2; `MemoryIndex.listChunks` / access rows include `chunkId`+`mtimeMs` from P4; modal/command names (`session.memory.browse`, `session.memory.remember`) consistent across Tasks 3–5.
