# Memory System P4 Implementation Plan (FTS5 Retrieval + Temporal Decay)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. P1–P3 must be complete — this consumes `MemoryRoots`, `readTextSafe`, `writeTextAtomic`, `scanForThreats`, `memory_search` tool internals, and the `sessions/` layout from P2.

**Goal:** Upgrade memory retrieval from file grep to a SQLite FTS5 (BM25) index with content-hash dedup, external-edit reindexing, and temporal-decay ranking (session logs decay, curated global/workspace exempt). The P1 `memory_search` tool switches to the index while keeping its input/output contract (path+line citations).

**Architecture:** Each memory root (global and workspace) owns a dedicated `index.sqlite` (gitignored, regenerable) with `chunks` (blake3 hash dedup + `access_count`) + contentless FTS5 `chunks_fts`. Search opens both indexes when workspace exists, merges hits, then ranks. A watcher accumulates dirty paths (Ref) and reindexes before search. Ranking: workspace > global > session base score, session decays exponentially (half-life 7 days), curated exempt, min_score filter, scaffold filtering. **Access contract:** every search hit, memory_read of indexed path, and recall inclusion bumps `access_count` for that chunk. Search falls back to the P1 grep path when both indexes are unavailable.

**Tech Stack:** TypeScript, Effect, `drizzle-orm/sqlite-core` (in-repo pattern per `session/sql.ts`), the repo's sqlite layer `@opencode-ai/effect-drizzle-sqlite` + `#sqlite` (verified: `packages/core/src/database/database.ts` uses `EffectDrizzleSqlite` + `sqliteLayer` — mirror that pattern for separate `index.sqlite` files), blake3 via `Bun.hash` (verified present), bun:test + `testEffect`.

## Global Constraints

- Repo: `/home/huyongjun/openpartner/opencode` (branch `fork-runtime-loop-f720490219`).
- New code under `packages/core/src/memory/`; tests under `packages/core/test/memory/`.
- Same style/Effect rules as P1–P3. No `as any`, no `@ts-ignore`.
- Index is **derived data**: always regenerable from files; corrupt/missing index → fallback to P1 grep path, never block reads.
- **Dual-root (architecture Option A):** `openMemoryIndex` / search operate on `{ globalDir/index.sqlite, workspaceDir?/index.sqlite }`; never a single shared DB for both roots.
- Hash dedup invariant: reindex of an unchanged chunk (same blake3 hash) is a no-op.
- **Access-count invariant:** `incrementAccess(chunkId)` on each search hit returned to the caller, each recall-included chunk (P6), and once per `memory_read` for chunks mapping to that path. Prune/health (P5/P8) only read this column.
- Ranking invariant: curated sources (global/workspace `MEMORY.md`) are exempt from temporal decay; session chunks decay with half-life 7 days (`score × e^(−λ·age_days)`, λ = ln2/7).
- Scaffold filter: auto-generated empty/stub chunks never appear in results (reuse Grok's `is_content_free` approach — structurally empty or short scaffold marker text).
- Typecheck gate `bun --cwd packages/core typecheck` clean; tests from `packages/core`.
- Commit per task. Execution Discipline from P1 applies.

---

## File Structure

```
packages/core/src/memory/
├── index-sql.ts         # drizzle schema: chunks + chunks_fts (contentless FTS5)
├── index.ts (modify)    # export MemoryIndex node + open/close
├── reindex.ts           # chunk_markdown (P4), hash dedup, reindex_file, delete_path, dirty watcher
├── ranking.ts           # decay math + scaffold filter + ranking comparator (pure, unit-testable)
└── (modify) tools.ts    # memory_search switches to index when available
packages/core/test/memory/
├── reindex.test.ts
├── ranking.test.ts
└── (modify) tools.test.ts (search-via-index assertions)
```

---

### Task 1: FTS5 index schema + open/close + chunking

**Files:**
- Create: `packages/core/src/memory/index-sql.ts`
- Create: `packages/core/src/memory/reindex.ts` (chunking part)
- Test: `packages/core/test/memory/reindex.test.ts`

**Interfaces:**
- Produces:
  - `export const openMemoryIndex = Effect.fn("Memory.openMemoryIndex")((fs, roots) => Effect.Effect<MemoryIndex>)` — opens `{globalDir}/index.sqlite` and, when present, `{workspaceDir}/index.sqlite`; returns a handle that searches/merges both
  - `export function chunkMarkdown(content: string, maxChars: number): Array<{ text: string; startLine: number; endLine: number }>` — markdown-aware: split on `##` headers, then paragraphs, then lines; continuation chunks carry ancestor header context (Grok strategy)
  - `export const chunkHash = (text: string): string` — blake3 hex (Bun.hash or crypto)
  - `MemoryIndex` also exposes `incrementAccess(ids: ReadonlyArray<string>): Effect.Effect<void>` and `listChunks()` for P5/P8

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/reindex.test.ts
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { resolveRoots } from "../../src/memory/storage"
import { openMemoryIndex } from "../../src/memory/reindex"
import { chunkMarkdown, chunkHash } from "../../src/memory/reindex"
import { writeTextAtomic } from "../../src/memory/storage"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(FSUtil.node)

describe("Memory index", () => {
  test("chunkMarkdown splits on headers", () => {
    const chunks = chunkMarkdown("## A\none\n\n## B\ntwo three four five", 200)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]!.text).toContain("## A")
  })

  test("chunkHash is stable hex", () => {
    expect(chunkHash("same")).toBe(chunkHash("same"))
    expect(chunkHash("same")).not.toBe(chunkHash("other"))
  })

  it.effect("openMemoryIndex creates index.sqlite and inserts a chunk", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      await using dir = await tmpdir()
      const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
      const index = yield* openMemoryIndex(fs, roots)
      yield* index.insert({ path: "MEMORY.md", source: "global", text: "remember to verify", startLine: 1, endLine: 1 })
      const hits = yield* index.search("verify")
      expect(hits.length).toBeGreaterThan(0)
      yield* index.close()
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/reindex.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/index-sql.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const MemoryChunkTable = sqliteTable("chunks", {
  id: text("id").primaryKey(), // chunkHash
  path: text("path").notNull(),
  startLine: integer("start_line").notNull(),
  endLine: integer("end_line").notNull(),
  text: text("text").notNull(),
  hash: text("hash").notNull(),
  source: text("source").notNull(), // "global" | "workspace" | "session"
  accessCount: integer("access_count").notNull().default(0),
})
// contentless FTS5 virtual table created via raw SQL:
// CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='')
```

```ts
// packages/core/src/memory/reindex.ts
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import type { MemoryRoots } from "./storage"

export interface MemoryIndex {
  readonly insert: (input: { path: string; source: string; text: string; startLine: number; endLine: number }) => Effect.Effect<void>
  readonly deletePath: (filePath: string) => Effect.Effect<void>
  readonly search: (query: string) => Effect.Effect<Array<{ path: string; line: number; text: string; score: number; id: string }>>
  readonly incrementAccess: (ids: ReadonlyArray<string>) => Effect.Effect<void>
  readonly listChunks: () => Effect.Effect<Array<{ id: string; path: string; source: string; accessCount: number; mtimeMs: number }>>
  readonly close: () => Effect.Effect<void>
}

export const chunkHash = (text: string): string => Bun.hash(text).toString(36)

export function chunkMarkdown(content: string, maxChars: number): Array<{ text: string; startLine: number; endLine: number }> {
  if (content.length <= maxChars) return [{ text: content, startLine: 1, endLine: content.split("\n").length }]
  const chunks: Array<{ text: string; startLine: number; endLine: number }> = []
  const sections = content.split(/(?=^## )/m)
  let line = 1
  for (const section of sections) {
    if (section.length <= maxChars) {
      chunks.push({ text: section.trim(), startLine: line, endLine: line + section.split("\n").length - 1 })
    } else {
      // paragraph split
      const paragraphs = section.split(/\n\n+/)
      let acc = ""
      let accStart = line
      for (const para of paragraphs) {
        if ((acc + "\n\n" + para).length > maxChars && acc) {
          chunks.push({ text: acc.trim(), startLine: accStart, endLine: line + para.split("\n").length - 1 })
          acc = para
          accStart = line
        } else {
          acc = acc ? acc + "\n\n" + para : para
        }
        line += para.split("\n").length + 1
      }
      if (acc) chunks.push({ text: acc.trim(), startLine: accStart, endLine: line })
    } else {
      line += section.split("\n").length
    }
  }
  return chunks
}

export const openMemoryIndex = Effect.fn("Memory.openMemoryIndex")(function* (fs: FSUtil.Service, roots: MemoryRoots) {
  // Open globalDir/index.sqlite always; also workspaceDir/index.sqlite when defined.
  // CREATE TABLE IF NOT EXISTS + FTS5 virtual table on each.
  // search() queries both, merges, caller runs rankResults.
  // Implement for real in Step 4 — do not ship a stub handle.
  return yield* Effect.die("Memory.openMemoryIndex: implement dual-root index (no stub)")
})
```

**Note:** Do not leave `as unknown as MemoryIndex` stubs. Step 4 must implement dual-root open + real insert/search/incrementAccess.

- [ ] **Step 4: Run test to verify it passes**

Read `packages/core/src/database/database.ts` and `packages/core/src/session/sql.ts` to determine the actual sqlite driver + drizzle client pattern in this repo. Implement `openMemoryIndex` with the real driver: `INSERT INTO chunks ... ON CONFLICT(id) DO NOTHING` for dedup, `DELETE FROM chunks WHERE path = ?` + FTS row cleanup for `deletePath`, and `SELECT ... FROM chunks_fts JOIN chunks ON ... WHERE chunks_fts MATCH ?` for `search`. Replace the `Effect.sync(() => ({}))` stub with the real handle — **the stub is a Step-3 placeholder only and MUST be replaced; leaving it is a rejected stub**. Align `chunkMarkdown` line tracking with the test expectations (fix off-by-one in the test if it is the test that is wrong, not the chunker — prefer fixing the chunker to match a sane spec: startLine 1-based inclusive).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/index-sql.ts packages/core/src/memory/reindex.ts packages/core/test/memory/reindex.test.ts
git commit -m "feat(memory): FTS5 index with markdown chunking and hash dedup"
```

---

### Task 2: Reindexing + dirty watcher + ranking

**Files:**
- Create: `packages/core/src/memory/ranking.ts`
- Modify: `packages/core/src/memory/reindex.ts` (add reindexFile + watcher)
- Test: `packages/core/test/memory/ranking.test.ts` + extend `reindex.test.ts`

**Interfaces:**
- Produces:
  - `export const TEMPORAL_HALF_LIFE_DAYS = 7`
  - `export function isContentFree(text: string): boolean` — structurally empty OR short scaffold (markers like "Add project-specific knowledge here")
  - `export function decayScore(score: number, ageDays: number, source: "global" | "workspace" | "session"): number` — session: `score × e^(−λ·ageDays)` (λ = ln2/7); curated: unchanged
  - `export function rankResults(items: Array<{ path: string; score: number; source: string; ageDays: number }>): Array<...>` — sort by decayed score desc; workspace-source tie-break first, then global, then session
  - `export const reindexFile = Effect.fn("Memory.reindexFile")((index, fs, roots, filePath, source) => Effect.Effect<void>)` — chunk, hash-dedup insert, delete stale chunks for path
  - `export const watchMemoryDir = Effect.fn("Memory.watchMemoryDir")(...)` — poll fs.mtimes every 30s, accumulate dirty, reindex before search (simplified watcher: no native notify, polling is fine for P4)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/ranking.test.ts
import { describe, expect, test } from "bun:test"
import { decayScore, rankResults, isContentFree, TEMPORAL_HALF_LIFE_DAYS } from "../../src/memory/ranking"

describe("Memory ranking", () => {
  test("half-life is 7 days", () => {
    expect(TEMPORAL_HALF_LIFE_DAYS).toBe(7)
  })

  test("session decays, curated exempt", () => {
    const session = decayScore(1, 7, "session")
    expect(session).toBeLessThan(0.6)
    expect(decayScore(1, 7, "global")).toBe(1)
    expect(decayScore(1, 7, "workspace")).toBe(1)
  })

  test("rank sorts by decayed score with curated tie-break", () => {
    const ranked = rankResults([
      { path: "sessions/a.md", score: 0.8, source: "session", ageDays: 7 },
      { path: "MEMORY.md", score: 0.8, source: "workspace", ageDays: 0 },
    ])
    expect(ranked[0]!.path).toBe("MEMORY.md")
  })

  test("scaffold content is filtered", () => {
    expect(isContentFree("Add project-specific knowledge here")).toBe(true)
    expect(isContentFree("## Decisions\nUse layers")).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/ranking.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/ranking.ts
export const TEMPORAL_HALF_LIFE_DAYS = 7

const SCAFFOLD_MARKERS = ["Add project-specific knowledge here", "Add any cross-project preferences here", "Auto-populated by dream consolidation"]

export function isContentFree(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return true
  return trimmed.length < 200 && SCAFFOLD_MARKERS.some((marker) => trimmed.includes(marker))
}

export function decayScore(score: number, ageDays: number, source: "global" | "workspace" | "session"): number {
  if (source !== "session") return score
  const lambda = Math.LN2 / TEMPORAL_HALF_LIFE_DAYS
  return score * Math.exp(-lambda * ageDays)
}

export function rankResults(
  items: Array<{ path: string; score: number; source: string; ageDays: number }>,
): Array<{ path: string; score: number; source: string; ageDays: number }> {
  const sourceRank = { workspace: 0, global: 1, session: 2 } as const
  return items
    .map((item) => ({ ...item, decayed: decayScore(item.score, item.ageDays, item.source as "session" | "global" | "workspace") }))
    .sort((a, b) => b.decayed - a.decayed || sourceRank[b.source as keyof typeof sourceRank] - sourceRank[a.source as keyof typeof sourceRank])
    .map(({ decayed: _decayed, ...rest }) => rest)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/ranking.test.ts`
Expected: PASS. Then extend `reindex.test.ts`:

```ts
it.effect("reindexFile inserts chunks and dedups on re-run", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    await using dir = await tmpdir()
    const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
    const index = yield* openMemoryIndex(fs, roots)
    yield* reindexFile(index, fs, roots, path.join(roots.globalDir, "MEMORY.md"), "global")
    yield* reindexFile(index, fs, roots, path.join(roots.globalDir, "MEMORY.md"), "global")
    const hits = yield* index.search("verify")
    expect(hits.length).toBeGreaterThan(0)
    yield* index.close()
  }),
)
```

Run: `bun test test/memory/reindex.test.ts test/memory/ranking.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/ranking.ts packages/core/src/memory/reindex.ts packages/core/test/memory/ranking.test.ts packages/core/test/memory/reindex.test.ts
git commit -m "feat(memory): temporal decay ranking and content-free filtering"
```

---

### Task 3: Switch memory_search to index with fallback + wiring gate

**Files:**
- Modify: `packages/core/src/memory/tools.ts` (search uses index when available)
- Modify: `packages/core/src/memory/reindex.ts` (export `memoryIndexNode` location node)
- Test: extend `packages/core/test/memory/tools.test.ts`

**Interfaces:**
- Consumes: Task 1 `openMemoryIndex`, Task 2 `reindexFile`/`rankResults`/`isContentFree`, P1 search contract
- Produces: `memory_search` behavior change only — same input/output shape, index-backed, grep fallback

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/tools.test.ts — append
it.live("memory_search returns ranked index hits with citations", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      withTool(tmp.path, (registry) =>
        Effect.gen(function* () {
          yield* fs.mkdir(path.join(tmp.path, ".opencode", "memory"), { recursive: true })
          yield* fs.writeFile(path.join(tmp.path, ".opencode", "memory", "MEMORY.md"), "line one\nremember to verify\ndecision: use layers")
          const output = yield* executeTool(registry, call("memory_search", { query: "verify" }))
          expect(output.matches.length).toBeGreaterThan(0)
          expect(output.matches[0].line).toBeGreaterThan(0)
        }),
      ),
  ),
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/tools.test.ts`
Expected: PASS already (grep fallback works) — **this test is a regression lock, not a red test**. To make it red, first wire the index: the test must assert the index path is taken. Add an assertion that the index file exists after search:

```ts
const indexExists = await fs.access(path.join(tmp.path, ".opencode", "memory", "index.sqlite")).then(() => true, () => false)
expect(indexExists).toBe(true)
```

- [ ] **Step 3: Wire the index into memory_search**

```ts
// packages/core/src/memory/tools.ts — search execute, index-first
execute: (input) =>
  Effect.gen(function* () {
    const root = rootsOf()
    const base = root.workspaceDir ?? root.globalDir
    const query = input.query.toLowerCase()
    const max = Math.min(input.max_results ?? DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS)
    const index = yield* openMemoryIndex(fs, root).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (index !== undefined) {
      const hits = yield* index.search(query)
      const ranked = rankResults(
        hits.map((hit) => ({
          path: hit.path,
          score: hit.score,
          source: hit.source ?? (hit.path.startsWith("sessions/") ? "session" : "workspace"),
          ageDays: hit.ageDays ?? 0, // derive from chunk/file mtime in reindex; do not leave forever-0 in production
          line: hit.line,
          text: hit.text,
          id: hit.id,
        })),
      )
      yield* index.incrementAccess(ranked.slice(0, max).map((hit) => hit.id)).pipe(Effect.catch(() => Effect.void))
      yield* index.close().pipe(Effect.catch(() => Effect.void))
      return {
        matches: ranked.slice(0, max).map((hit) => ({ path: hit.path, line: hit.line ?? 0, text: hit.text })),
      }
    }
    // fallback: existing grep walk (no access_count — index absent)
    ...existing grep implementation...
  }),
```

**Access contract:** every returned index hit must `incrementAccess` before return. `memory_read` of an indexed path must bump matching chunk ids once per call (add in the same Task or a follow-up commit in this phase — do not defer to P5).

- [ ] **Step 4: Run tests to verify they pass + wiring gate**

Run: `bun test test/memory/tools.test.ts test/memory/reindex.test.ts` — PASS. Typecheck: `bun --cwd packages/core typecheck` — clean.

**接线完整性检查（强制）：**
```bash
grep -n "openMemoryIndex" packages/core/src/memory/tools.ts   # MUST match (index path)
grep -n "index.sqlite" packages/core/src/memory/*.ts          # MUST match
grep -n "rankResults" packages/core/src/memory/tools.ts       # MUST match
grep -n "incrementAccess" packages/core/src/memory/tools.ts   # MUST match (access contract)
grep -n "globalDir\|workspaceDir" packages/core/src/memory/reindex.ts  # MUST match dual-root
bun test test/memory/  # MUST pass (full suite)
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/tools.ts packages/core/src/memory/reindex.ts packages/core/test/memory/tools.test.ts
git commit -m "feat(memory): index-backed memory_search with ranking and grep fallback"
```

---

## Self-Review

**Spec coverage (architecture doc P4):** dual-root FTS5 + hash dedup → Task 1; access_count increment on search/read → Task 3 wiring; external-edit reindex → Task 2; temporal decay + curated exempt + scaffold filter + ranking → Task 2; search switch with graceful fallback → Task 3; `index.sqlite` gitignored per root (extend `docs/memory/.gitignore.example`).

**Placeholder scan:** no shippable stubs; `Effect.die` placeholder in Task 1 Step 3 must be replaced before Task 1 Step 4 passes.

**Known discovery-risk items (flagged):** sqlite driver pattern must be read from `database.ts` before implementing `openMemoryIndex` (Task 1 Step 4); mtime-derived `ageDays` for decay must be wired (not left at 0).

**Type consistency:** `MemoryRoots`/`writeTextAtomic`/`readTextSafe` from P1; `openMemoryIndex`/`chunkMarkdown`/`chunkHash`/`incrementAccess` (Task 1) consumed by Tasks 2/3 and P5/P6/P8; `reindexFile`/`rankResults`/`isContentFree`/`decayScore` (Task 2) consumed by Task 3; `memory_search` output contract unchanged from P1 (+ optional id for access bump).
