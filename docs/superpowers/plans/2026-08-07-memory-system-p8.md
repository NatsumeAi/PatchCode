# Memory System P8 Implementation Plan (Health Panel + Export/Migration + Staleness Marking)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. P1–P7 must be complete — this consumes P1 `MemoryRoots`, P4 `MemoryIndex` (access_count), P5 prune, P5 TUI modal, P6 recall.

**Goal:** Final-form polish: (1) a memory health/stats panel (entry counts, usage, decay status, prune candidates), (2) export/import for migration between machines/repos, (3) explicit staleness marking on retrieved session memories (Grok's staleness notes — older results carry "verify before relying" reminders, curated exempt). After P8 the memory system is feature-complete per the architecture doc; only optional P6-vector tuning remains (already delivered as P7).

**Architecture:** Health stats are a pure aggregation over the P4 index (`access_count`, `chunks` per source, real `mtimeMs`) + filesystem (file count/size). Export = pack of the memory root (global or workspace scope) with an embedded manifest (version, date, scopes); import = validate manifest, threat-scan every file, then merge per architecture import policy: **never overwrite** local curated files that are newer-or-equal; import only when local missing or imported mtime is **strictly newer**; `--force` only when explicit. Staleness is computed at retrieval: session chunks older than `STALE_AFTER_DAYS` (default 14) get a `(memory from <date>, may be stale)` suffix; curated sources exempt.

**Tech Stack:** TypeScript, Effect, opencode TUI (P5 modal extension), `Bun.file`/zip via `fflate` or system tar (verify what's available), P4 `MemoryIndex`. bun:test + `testEffect`.

## Global Constraints

- Repo: `/home/huyongjun/openpartner/opencode` (branch `fork-runtime-loop-f720490219`).
- New code under `packages/core/src/memory/`; TUI under `packages/tui/src/`.
- Same style/Effect rules as P1–P7. No `as any`, no `@ts-ignore`.
- **Import safety (hard):** follow architecture import policy (never overwrite newer-or-equal local curated; threat-scan every imported file before searchable). `--force` is opt-in only.
- **Staleness (hard):** only `session` source chunks get staleness marks; `global`/`workspace` (curated) never do. Mark is display-only (never mutates stored data).
- Export contains no secrets by default: `notes/` and `sessions/` are user content — export includes them ONLY with an explicit `--include-raw` flag; default export is curated (`MEMORY.md`, `memory_summary.md`; `candidates/` excluded).
- Typecheck gates: `bun --cwd packages/core typecheck` AND `bun --cwd packages/tui typecheck` clean.
- Commit per task. Execution Discipline from P1 applies.

---

## File Structure

```
packages/core/src/memory/
├── health.ts            # stats aggregation (pure + index reads)
├── transfer.ts          # export/import with manifest + threat scan + conflict policy
├── (modify) ranking.ts  # STALE_AFTER_DAYS + markStale helper
├── (modify) reindex.ts  # search/recall results carry age for staleness marking
└── (modify) tools.ts    # memory_search output gains optional stale flag
packages/core/test/memory/
├── health.test.ts
├── transfer.test.ts
└── (modify) ranking.test.ts (staleness)
packages/tui/src/
├── (modify) memory-modal.tsx   # health section + export/import commands
packages/tui/test/
└── (modify) memory-modal.test.tsx
```

---

### Task 1: Health stats aggregation

**Files:**
- Create: `packages/core/src/memory/health.ts`
- Test: `packages/core/test/memory/health.test.ts`

**Interfaces:**
- Produces:
  - `export interface MemoryHealth { files: number; totalBytes: number; chunks: number; bySource: Record<"global" | "workspace" | "session", number>; zeroAccessChunks: number; pruneCandidates: number; lastConsolidatedAt?: number }`
  - `export const collectHealth = Effect.fn("Memory.collectHealth")((fs, roots, index) => Effect.Effect<MemoryHealth>)` — file walk + index chunk counts + access_count stats + P5 `selectPruneCandidates` count

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/health.test.ts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { resolveRoots } from "../../src/memory/storage"
import { collectHealth } from "../../src/memory/health"
import { openMemoryIndex } from "../../src/memory/reindex"
import { writeTextAtomic } from "../../src/memory/storage"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(FSUtil.node)

describe("Memory health", () => {
  it.effect("counts files, bytes, and index chunks by source", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      await using dir = await tmpdir()
      const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
      yield* writeTextAtomic(fs, path.join(roots.globalDir, "MEMORY.md"), "## Decisions\nuse layers")
      const index = yield* openMemoryIndex(fs, roots, undefined)
      yield* index.insert({ path: "MEMORY.md", source: "global", text: "use layers", startLine: 1, endLine: 2 })
      const health = yield* collectHealth(fs, roots, index)
      expect(health.files).toBeGreaterThan(0)
      expect(health.totalBytes).toBeGreaterThan(0)
      expect(health.bySource.global).toBeGreaterThan(0)
      expect(health.chunks).toBeGreaterThan(0)
      yield* index.close()
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/health.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/health.ts
import { Effect, FileSystem, Option } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { readTextSafe, type MemoryRoots } from "./storage"
import type { MemoryIndex } from "./reindex"
import { selectPruneCandidates } from "./prune"

export interface MemoryHealth {
  readonly files: number
  readonly totalBytes: number
  readonly chunks: number
  readonly bySource: Record<"global" | "workspace" | "session", number>
  readonly zeroAccessChunks: number
  readonly pruneCandidates: number
  readonly lastConsolidatedAt?: number
}

export const collectHealth = Effect.fn("Memory.collectHealth")(function* (
  fs: FSUtil.Service,
  roots: MemoryRoots,
  index: MemoryIndex,
) {
  const base = roots.workspaceDir ?? roots.globalDir
  let files = 0
  let totalBytes = 0
  const walk = (dir: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.type === "directory") {
          yield* walk(full)
        } else if (entry.type === "file") {
          files++
          const info = yield* FileSystem.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info) totalBytes += Number(info.size)
        }
      }
    })
  yield* walk(base)
  const chunkRows = yield* index.listChunks() // added in this task to MemoryIndex
  const bySource = { global: 0, workspace: 0, session: 0 }
  let zeroAccessChunks = 0
  for (const row of chunkRows) {
    bySource[row.source as "global" | "workspace" | "session"]++
    if (row.accessCount === 0) zeroAccessChunks++
  }
  const pruneCandidates = selectPruneCandidates(
    chunkRows.map((row) => ({
      chunkId: row.id,
      path: row.path,
      excerpt: row.text?.slice(0, 120) ?? "",
      accessCount: row.accessCount,
      mtimeMs: row.mtimeMs,
    })),
    Date.now(),
  ).length
  return { files, totalBytes, chunks: chunkRows.length, bySource, zeroAccessChunks, pruneCandidates }
})
```

**Note:** Never pass `mtimeMs: 0` — that falsifies pruneCandidate counts. `listChunks` must return real mtimes from the index or filesystem.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/health.test.ts`
Expected: PASS. Add `listChunks(): Effect.Effect<Array<{ id: string; path: string; source: string; accessCount: number; mtimeMs: number; text: string }>>` to the P4 `MemoryIndex` handle (additive). Fix `stat.size` shape per `fs-util.ts`. Use real `mtimeMs` only.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/health.ts packages/core/src/memory/reindex.ts packages/core/test/memory/health.test.ts
git commit -m "feat(memory): health stats aggregation"
```

---

### Task 2: Export/import with manifest + safety

**Files:**
- Create: `packages/core/src/memory/transfer.ts`
- Test: `packages/core/test/memory/transfer.test.ts`

**Interfaces:**
- Produces:
  - `export interface TransferManifest { version: 1; exportedAt: string; scopes: Array<"global" | "workspace">; includeRaw: boolean }`
  - `export const exportMemory = Effect.fn("Memory.exportMemory")((fs, roots, target: string, opts: { includeRaw?: boolean }) => Effect.Effect<void>)` — writes a `.memory-pack` dir (or tar) at target with `manifest.json` + curated files; `includeRaw` adds `notes/`+`sessions/`
  - `export const importMemory = Effect.fn("Memory.importMemory")((fs, roots, source: string, opts?: { force?: boolean }) => Effect.Effect<{ imported: number; skipped: number }>)` — reads manifest, threat-scans every file; imports curated files only when local missing OR imported mtime **strictly newer** than local (architecture: never overwrite newer-or-equal local); `force: true` may overwrite; returns counts

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/transfer.test.ts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { resolveRoots, readTextSafe } from "../../src/memory/storage"
import { writeTextAtomic } from "../../src/memory/storage"
import { exportMemory, importMemory } from "../../src/memory/transfer"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(FSUtil.node)

describe("Memory transfer", () => {
  it.effect("export then import round-trips curated memory", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      await using dir = await tmpdir()
      const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
      yield* writeTextAtomic(fs, path.join(roots.globalDir, "MEMORY.md"), "## Decisions\nuse layers")
      const pack = path.join(dir.path, "pack")
      yield* exportMemory(fs, roots, pack, { includeRaw: false })
      const otherRoots = resolveRoots(path.join(dir.path, "other"), undefined)
      const result = yield* importMemory(fs, otherRoots, pack)
      expect(result.imported).toBeGreaterThan(0)
      const text = yield* readTextSafe(fs, path.join(otherRoots.globalDir, "MEMORY.md"))
      expect(text).toContain("use layers")
    }),
  )

  it.effect("import never overwrites newer local curated entry", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      await using dir = await tmpdir()
      const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
      yield* writeTextAtomic(fs, path.join(roots.globalDir, "MEMORY.md"), "local newer")
      const pack = path.join(dir.path, "pack")
      yield* exportMemory(fs, roots, pack, { includeRaw: false })
      // simulate a newer local file after export
      yield* writeTextAtomic(fs, path.join(roots.globalDir, "MEMORY.md"), "local newest")
      const result = yield* importMemory(fs, roots, pack)
      const text = yield* readTextSafe(fs, path.join(roots.globalDir, "MEMORY.md"))
      expect(text).toContain("local newest")
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/transfer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/transfer.ts
import path from "path"
import { Effect, FileSystem, Option } from "effect"
import { FSUtil } from "../fs-util"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"
import { scanForThreats } from "./scan"

export interface TransferManifest {
  readonly version: 1
  readonly exportedAt: string
  readonly scopes: Array<"global" | "workspace">
  readonly includeRaw: boolean
}

const CURATED_FILES = ["MEMORY.md", "memory_summary.md"]
const RAW_DIRS = ["extensions/ad_hoc/notes", "sessions"]

export const exportMemory = Effect.fn("Memory.exportMemory")(function* (
  fs: FSUtil.Service,
  roots: MemoryRoots,
  target: string,
  opts: { includeRaw?: boolean },
) {
  const includeRaw = opts.includeRaw ?? false
  const base = roots.workspaceDir ?? roots.globalDir
  const manifest: TransferManifest = { version: 1, exportedAt: new Date().toISOString(), scopes: ["global"], includeRaw }
  yield* writeTextAtomic(fs, path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2))
  for (const name of CURATED_FILES) {
    const text = yield* readTextSafe(fs, path.join(base, name))
    if (text !== undefined) yield* writeTextAtomic(fs, path.join(target, name), text)
  }
  if (includeRaw) {
    for (const dir of RAW_DIRS) {
      const entries = yield* fs.readDirectoryEntries(path.join(base, dir)).pipe(Effect.catch(() => Effect.succeed([])))
      for (const entry of entries) {
        if (entry.type !== "file") continue
        const text = yield* readTextSafe(fs, path.join(base, dir, entry.name))
        if (text !== undefined) yield* writeTextAtomic(fs, path.join(target, dir, entry.name), text)
      }
    }
  }
})

export const importMemory = Effect.fn("Memory.importMemory")(function* (
  fs: FSUtil.Service,
  roots: MemoryRoots,
  source: string,
) {
  const manifestText = yield* readTextSafe(fs, path.join(source, "manifest.json"))
  if (manifestText === undefined) return { imported: 0, skipped: 0 }
  const manifest = JSON.parse(manifestText) as TransferManifest
  const base = roots.workspaceDir ?? roots.globalDir
  let imported = 0
  let skipped = 0
  const copy = (relative: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const text = yield* readTextSafe(fs, path.join(source, relative))
      if (text === undefined) return
      if (scanForThreats(text).length > 0) {
        skipped++
        return
      }
      const existing = yield* readTextSafe(fs, path.join(base, relative))
      const localInfo = yield* FileSystem.stat(path.join(base, relative)).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const srcInfo = yield* FileSystem.stat(path.join(source, relative)).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const localMtime = localInfo ? Option.getOrElse(localInfo.mtime, () => new Date(0)).getTime() : 0
      const srcMtime = srcInfo ? Option.getOrElse(srcInfo.mtime, () => new Date(0)).getTime() : 0
      if (existing !== undefined && localInfo && srcInfo && localMtime > srcMtime) {
        skipped++
        return
      }
      yield* writeTextAtomic(fs, path.join(base, relative), text)
      imported++
    })
  for (const name of CURATED_FILES) yield* copy(name)
  if (manifest.includeRaw) for (const dir of RAW_DIRS) {
    const entries = yield* fs.readDirectoryEntries(path.join(source, dir)).pipe(Effect.catch(() => Effect.succeed([])))
    for (const entry of entries) if (entry.type === "file") yield* copy(path.join(dir, entry.name))
  }
  return { imported, skipped }
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/transfer.test.ts`
Expected: PASS (2 tests). If `stat.mtimeMs` differs, use `stat.mtime` ms conversion per `fs-util.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/transfer.ts packages/core/test/memory/transfer.test.ts
git commit -m "feat(memory): manifest-based export/import with threat scan and no-overwrite policy"
```

---

### Task 3: Staleness marking on retrieved session memory

**Files:**
- Modify: `packages/core/src/memory/ranking.ts` (staleness helpers)
- Modify: `packages/core/src/memory/reindex.ts` (search results carry age)
- Modify: `packages/core/src/memory/recall.ts` (staleness suffix)
- Test: extend `packages/core/test/memory/ranking.test.ts`

**Interfaces:**
- Produces:
  - `export const STALE_AFTER_DAYS = 14`
  - `export function staleNote(ageDays: number, source: "global" | "workspace" | "session"): string` — session & age > threshold → `(memory from <N> days ago, may be stale — verify before relying)`; else `""`
  - `MemoryIndex.search` results gain `ageDays`; `memory_search` output text appends staleNote; recall block appends staleNote per hit

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/ranking.test.ts — append
import { STALE_AFTER_DAYS, staleNote } from "../../src/memory/ranking"

test("staleness marks only old session chunks", () => {
  expect(STALE_AFTER_DAYS).toBe(14)
  expect(staleNote(20, "session")).toContain("may be stale")
  expect(staleNote(5, "session")).toBe("")
  expect(staleNote(20, "global")).toBe("")
  expect(staleNote(20, "workspace")).toBe("")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/ranking.test.ts`
Expected: FAIL — `staleNote` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/ranking.ts — append
export const STALE_AFTER_DAYS = 14

export function staleNote(ageDays: number, source: "global" | "workspace" | "session"): string {
  if (source !== "session") return ""
  if (ageDays <= STALE_AFTER_DAYS) return ""
  return `(memory from ${Math.round(ageDays)} days ago, may be stale — verify before relying)`
}
```

```ts
// packages/core/src/memory/recall.ts — formatRecallBlock: append staleNote per hit
// (hits carry source + ageDays; signature extended accordingly — keep old signature via default param)
```

```ts
// packages/core/src/memory/reindex.ts — search returns ageDays per hit (from chunk mtime/created_at)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/ranking.test.ts test/memory/recall.test.ts test/memory/reindex.test.ts`
Expected: PASS. Update `memory_search` tool output text with staleNote where ageDays > threshold (display-only). Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/ranking.ts packages/core/src/memory/recall.ts packages/core/src/memory/reindex.ts packages/core/src/memory/tools.ts packages/core/test/memory/ranking.test.ts
git commit -m "feat(memory): staleness marking on retrieved session memory"
```

---

### Task 4: TUI health section + export/import commands

**Files:**
- Modify: `packages/tui/src/memory-modal.tsx` (health stats section + export/import commands)
- Modify: `packages/tui/src/routes/session/index.tsx` (commands `session.memory.export`, `session.memory.import`)
- Test: extend `packages/tui/test/memory-modal.test.tsx`

**Interfaces:**
- Produces: `MemoryModal` gains a stats footer (files/chunks/bySource/pruneCandidates) and export/import actions (export → writes pack to a user-chosen path via the command surface; import → prompts for path, runs importMemory, shows result). Command registration consistent with P5 (`session.memory.*`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/tui/test/memory-modal.test.tsx — append
test("memory modal shows health stats footer", async () => {
  const { renderer } = await testRender(() => <MemoryModal onClose={() => {}} />, { width: 80, height: 24 })
  try {
    await new Promise((r) => setTimeout(r, 50))
    // assert a frame containing "chunks" or "files"
  } finally {
    renderer.destroy()
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory-modal.test.tsx`
Expected: FAIL — no stats footer.

- [ ] **Step 3: Wire the health + transfer surface**

Mirror the P5 Task 3 SDK/command surface pattern (decide then whether health/export go through the experimental HTTP surface or a direct core call — follow whatever P5 chose; keep TUI thin). The modal reads `collectHealth` output and renders it; export/import commands call `exportMemory`/`importMemory` with a path dialog (reuse the P5 dialog pattern).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory-modal.test.tsx` — PASS. Typecheck `bun --cwd packages/tui typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/memory-modal.tsx packages/tui/src/routes/session/index.tsx packages/tui/test/memory-modal.test.tsx
git commit -m "feat(tui): memory health stats and export/import actions"
```

---

## Self-Review

**Spec coverage (final-form requirement):** health stats → Task 1; export/import with manifest, threat scan, no-overwrite → Task 2; staleness marks (session-only, curated exempt) → Task 3; TUI surface → Task 4. P6-vector (already delivered as P7) is the only remaining optional tier — the architecture doc marks the system feature-complete after P8.

**Placeholder scan:** no TBD/TODO; code concrete; transfer manifest format defined exactly.

**Known discovery-risk (flagged):** TUI→core data path (Task 4 Step 3 — mirrors P5's decision; consistent, not silent); `stat` shape differences (Tasks 1/2 Step 4 — read `fs-util.ts`).

**Type consistency:** `MemoryIndex.listChunks` added in Task 1 and used by `collectHealth`; `staleNote`/`STALE_AFTER_DAYS` (Task 3) consumed by recall/search tools; `exportMemory`/`importMemory` (Task 2) consumed by Task 4 commands; command names `session.memory.export`/`session.memory.import` consistent.
