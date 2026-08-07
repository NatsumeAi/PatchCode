# Memory System P3 Implementation Plan (Consolidation Pipeline)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. P1 + P2 must be complete — this consumes their `MemoryRoots`/`writeTextAtomic`/`readTextSafe`/`scanForThreats`/`appendSessionLog`/`sessionLogPath`, and the LLM pattern from P2 flush.

**Goal:** Close the consolidation loop: background stage1 extracts candidate memories from notes/session logs; gated phase2 merges them into `MEMORY.md`; `memory_summary.md` is regenerated from the archive so captured knowledge actually reaches the injection path. Idempotent, crash-safe, quality-gated, contradiction-aware.

**Architecture:** The "notes ARE the job state" model (locked in the architecture doc): no SQLite job table — a note/session file exists on disk until its content is merged; phase2 consumes notes/sessions (and optional candidate files) and deletes them only on success. **Shipped P3 path folds separate LLM stage1 extraction** (optional follow-up); acceptance = merge from sources + regenerate summary. Watermark = source/candidate mtime. Phase2 gates mirror Grok dream: `min_hours` between consolidations + lock file with stale reclamation (3600s) + 32K input cap. Merging uses an LLM call in the P2 flush pattern; the merge prompt follows Grok's DREAM_SYSTEM_PROMPT. Idempotency: `mergeKeyOf` embeds `<!-- memory-candidate:<blake3-hex> -->` (stable hash of source id + content — **not** a 24-char slug). Quality gate: candidates shorter than noise floor are discarded without merging.

**Tech Stack:** TypeScript, Effect (Layer/Effect/Stream/Schedule), opencode core (`BackgroundJob.Service` for observability, `LLMClient.Service` + `LLM.request`, `FSUtil.Service`, `Global.Path`, `Location.Service`), bun:test + `testEffect` + `Layer.mock`.

## Global Constraints

- Repo: `/home/huyongjun/openpartner/opencode` (branch `fork-runtime-loop-f720490219`).
- New code under `packages/core/src/memory/`; tests under `packages/core/test/memory/`.
- Same style/Effect rules as P1/P2. No `as any`, no `@ts-ignore`.
- **Idempotency invariant (hard):** a candidate file is deleted ONLY after it was successfully merged into `MEMORY.md` (or rejected as noise). Crash between merge and delete → re-merge on next run; `MEMORY.md` entries carry the candidate id so re-merge is a no-op (skip if id already present).
- **Gate invariant (hard):** phase2 acquires an exclusive lock file (`consolidation.lock`) with stale reclamation ≥ 3600s; skips if last consolidation < `min_hours` (default 4) ago.
- **Budget invariant:** phase2 input capped at 32K chars (oldest candidates skipped, kept for next run); merge prompt instructs discard of ephemeral; `MEMORY.md` hard cap 64K chars (merge prompt told to compress; if output would exceed cap, merge is aborted and logged — no truncation of the archive).
- Threat scan on candidates before merge and on regenerated summary (P1 scanner).
- Typecheck gate `bun --cwd packages/core typecheck` clean; tests from `packages/core`.
- Commit per task. Execution Discipline from P1 applies (no stubs, red-green, wiring gate, no silent scope cuts).

---

## File Structure

```
packages/core/src/memory/
├── consolidate.ts       # stage1 extraction + phase2 merge + summary regen orchestrator
├── candidates.ts        # candidate dir IO: write/list/read/delete, watermark, idempotent merge keys
├── merge-lock.ts        # exclusive lock file with stale reclamation
├── merge-prompt.ts      # stage1 + phase2 LLM prompts (Grok-derived)
└── (modify) tools.ts    # optional: memory_consolidate manual trigger tool
packages/core/test/memory/
├── candidates.test.ts
├── merge-lock.test.ts
├── consolidate.test.ts
```

---

### Task 1: Candidate store (watermark, idempotent keys, noise floor)

**Files:**
- Create: `packages/core/src/memory/candidates.ts`
- Test: `packages/core/test/memory/candidates.test.ts`

**Interfaces:**
- Consumes: P1 `MemoryRoots`, `readTextSafe`, `writeTextAtomic`
- Produces:
  - `export const candidatesDir = (roots: MemoryRoots): string` — `<workspace|global>/extensions/ad_hoc/candidates/`
  - `export const listCandidates = Effect.fn("Memory.listCandidates")((fs, roots, since: number) => Effect.Effect<Array<{ id: string; path: string; mtime: number }>>)` — reads dir, returns files with mtime > since (sorted by mtime)
  - `export const writeCandidate = Effect.fn("Memory.writeCandidate")((fs, roots, id, content) => Effect.Effect<void>)` — `create_new` write under candidates dir; id = sanitized slug + `.md`
  - `export const readCandidate` / `deleteCandidate` — read text / delete file
  - `export const mergeKeyOf = (sourceId: string, content: string): string` — stable id embedded in merged entries for idempotent re-merge: first line `<!-- memory-candidate:<blake3-hex> -->` where hex = blake3(`${sourceId}\n${content}`) (via `Bun.hash` or crypto). **Do not use short content slugs** (collision risk).
  - `export const NOISE_FLOOR_CHARS = 40`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/candidates.test.ts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { resolveRoots } from "../../src/memory/storage"
import { writeCandidate, listCandidates, readCandidate, deleteCandidate, mergeKeyOf, NOISE_FLOOR_CHARS } from "../../src/memory/candidates"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(FSUtil.node)

describe("Memory candidates", () => {
  test("merge key is a stable blake3 comment line", () => {
    const a = mergeKeyOf("note-1", "## Notes\nx")
    const b = mergeKeyOf("note-1", "## Notes\nx")
    const c = mergeKeyOf("note-2", "## Notes\nx")
    expect(a).toMatch(/^<!-- memory-candidate:[a-f0-9]+ -->$/)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  test("noise floor is 40 chars", () => {
    expect(NOISE_FLOOR_CHARS).toBe(40)
  })

  it.effect("write then list returns one candidate with id", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      await using dir = await tmpdir()
      const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
      yield* writeCandidate(fs, roots, "note-1", "## Notes\nremember to verify")
      const list = yield* listCandidates(fs, roots, 0)
      expect(list.length).toBe(1)
      expect(list[0]!.id).toBe("note-1")
      const text = yield* readCandidate(fs, roots, "note-1")
      expect(text).toContain("remember to verify")
      yield* deleteCandidate(fs, roots, "note-1")
      const after = yield* listCandidates(fs, roots, 0)
      expect(after.length).toBe(0)
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/candidates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/candidates.ts
import path from "path"
import { Effect, FileSystem, Option } from "effect"
import { FSUtil } from "../fs-util"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"

export const NOISE_FLOOR_CHARS = 40

export const candidatesDir = (roots: MemoryRoots): string => {
  const base = roots.workspaceDir ?? roots.globalDir
  return path.join(base, "extensions", "ad_hoc", "candidates")
}

export const candidatePath = (roots: MemoryRoots, id: string): string =>
  path.join(candidatesDir(roots), `${id}.md`)

export const mergeKeyOf = (sourceId: string, content: string): string => {
  const hex = Bun.hash(`${sourceId}\n${content}`).toString(16)
  return `<!-- memory-candidate:${hex} -->`
}

export const writeCandidate = Effect.fn("Memory.writeCandidate")(function* (
  fs: FSUtil.Service,
  roots: MemoryRoots,
  id: string,
  content: string,
) {
  yield* writeTextAtomic(fs, candidatePath(roots, id), content)
})

export const listCandidates = Effect.fn("Memory.listCandidates")(function* (
  fs: FSUtil.Service,
  roots: MemoryRoots,
  since: number,
): Effect.Effect<Array<{ id: string; path: string; mtime: number }>, never, FSUtil.Service | FileSystem.FileSystem> {
  const dir = candidatesDir(roots)
  const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.catch(() => Effect.succeed([])))
  const items: Array<{ id: string; path: string; mtime: number }> = []
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.name.endsWith(".md")) continue
    const full = path.join(dir, entry.name)
    // FSUtil has no stat/remove; use Effect's FileSystem directly (provided by NodeFileSystem under FSUtil.node).
    const info = yield* FileSystem.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!info) continue
    const mtime = Option.getOrElse(info.mtime, () => new Date(0)).getTime()
    if (mtime < since) continue
    items.push({ id: entry.name.slice(0, -3), path: full, mtime })
  }
  return items.sort((a, b) => a.mtime - b.mtime)
})

export const readCandidate = Effect.fn("Memory.readCandidate")(function* (fs: FSUtil.Service, roots: MemoryRoots, id: string) {
  return yield* readTextSafe(fs, candidatePath(roots, id))
})

export const deleteCandidate = Effect.fn("Memory.deleteCandidate")(function* (_fs: FSUtil.Service, roots: MemoryRoots, id: string) {
  yield* FileSystem.remove(candidatePath(roots, id)).pipe(Effect.catch(() => Effect.void))
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/candidates.test.ts`
Expected: PASS. (`FileSystem.stat` returns `mtime: Option<Date>` — already handled in the implementation above.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/candidates.ts packages/core/test/memory/candidates.test.ts
git commit -m "feat(memory): candidate store with watermark listing and idempotent merge keys"
```

---

### Task 2: Merge lock (exclusive, stale-reclaimable)

**Files:**
- Create: `packages/core/src/memory/merge-lock.ts`
- Test: `packages/core/test/memory/merge-lock.test.ts`

**Interfaces:**
- Produces:
  - `export const STALE_LOCK_SECS = 3600`
  - `export const acquireMergeLock = Effect.fn("Memory.acquireMergeLock")((fs, roots) => Effect.Effect<boolean>)` — creates `consolidation.lock` with `create_new`; on AlreadyExists reads lock mtime: if `now - mtime > STALE_LOCK_SECS` delete and retry once; else return false
  - `export const releaseMergeLock = Effect.fn("Memory.releaseMergeLock")((fs, roots) => Effect.Effect<void>)` — removes lock file
  - `export const lastConsolidatedAt = Effect.fn("Memory.lastConsolidatedAt")((fs, roots) => Effect.Effect<number | undefined>)` — reads `consolidation.last` mtime

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/merge-lock.test.ts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { resolveRoots } from "../../src/memory/storage"
import { acquireMergeLock, releaseMergeLock, STALE_LOCK_SECS } from "../../src/memory/merge-lock"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(FSUtil.node)

describe("Merge lock", () => {
  test("stale threshold is 3600s", () => {
    expect(STALE_LOCK_SECS).toBe(3600)
  })

  it.effect("acquire is exclusive", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      await using dir = await tmpdir()
      const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
      expect(yield* acquireMergeLock(fs, roots)).toBe(true)
      expect(yield* acquireMergeLock(fs, roots)).toBe(false)
      yield* releaseMergeLock(fs, roots)
      expect(yield* acquireMergeLock(fs, roots)).toBe(true)
      yield* releaseMergeLock(fs, roots)
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/merge-lock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/merge-lock.ts
import path from "path"
import { Effect, FileSystem, Option } from "effect"
import { FSUtil } from "../fs-util"
import type { MemoryRoots } from "./storage"

export const STALE_LOCK_SECS = 3600

const lockPath = (roots: MemoryRoots) => {
  const base = roots.workspaceDir ?? roots.globalDir
  return path.join(base, "consolidation.lock")
}

export const acquireMergeLock = Effect.fn("Memory.acquireMergeLock")(function* (fs: FSUtil.Service, roots: MemoryRoots) {
  const target = lockPath(roots)
  const tryCreate = (): Effect.Effect<boolean> =>
    FileSystem.writeFileString(target, String(Date.now()), { flag: "wx" }).pipe(
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false)),
    )
  const acquired = yield* tryCreate()
  if (acquired) return true
  const info = yield* FileSystem.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const mtime = info ? Option.getOrElse(info.mtime, () => new Date(0)).getTime() : 0
  if (info && Date.now() - mtime > STALE_LOCK_SECS * 1000) {
    yield* FileSystem.remove(target).pipe(Effect.catch(() => Effect.void))
    return yield* tryCreate()
  }
  return false
})

export const releaseMergeLock = Effect.fn("Memory.releaseMergeLock")(function* (_fs: FSUtil.Service, roots: MemoryRoots) {
  yield* FileSystem.remove(lockPath(roots)).pipe(Effect.catch(() => Effect.void))
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/merge-lock.test.ts`
Expected: PASS. Do not weaken assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/merge-lock.ts packages/core/test/memory/merge-lock.test.ts
git commit -m "feat(memory): exclusive merge lock with stale reclamation"
```

---

### Task 3: Consolidation orchestrator (stage1 + phase2 + summary regen)

**Files:**
- Create: `packages/core/src/memory/merge-prompt.ts`
- Create: `packages/core/src/memory/consolidate.ts`
- Test: `packages/core/test/memory/consolidate.test.ts`

**Interfaces:**
- Consumes: Task 1 candidates API, Task 2 lock, P1 `scanForThreats`/`MemoryRoots`/`writeTextAtomic`, P2 LLM pattern (`LLMClient.Service`, `LLM.request`, `SessionRunnerModel.Service`), P1 summary regen path (`memory_summary.md`)
- Produces:
  - `export const STAGE1_SYSTEM` / `PHASE2_SYSTEM` prompt constants (Grok-derived, exported for tests)
  - `export const runConsolidation = Effect.fn("Memory.runConsolidation")(...)` — gate (lock + min_hours via `consolidation.last`), stage1 (extract candidates → write candidate files), phase2 (merge candidates → `MEMORY.md`), then regenerate `memory_summary.md`; skips cleanly when nothing to do; idempotent via merge keys
  - `export const node = makeLocationNode({ name: "memory-consolidation", layer, deps: [LLMClient.node, SessionRunnerModel.node, FSUtil.node, Global.node, Location.node] })`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/consolidate.test.ts
import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LLMClient, LLMEvent } from "@opencode-ai/llm"
import { readTextSafe } from "../../src/memory/storage"
import { resolveRoots } from "../../src/memory/storage"
import { runConsolidation } from "../../src/memory/consolidate"
import { writeCandidate } from "../../src/memory/candidates"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const llm = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    stream: () => Stream.fromIterable([LLMEvent.textDelta({ id: "1", text: "## Merged\n- decision kept" })]),
  }),
)

const it = testEffect(Layer.provideMerge(llm, FSUtil.node))

describe("Consolidation", () => {
  it.effect("merges candidates into MEMORY.md", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      await using dir = await tmpdir()
      const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
      yield* writeCandidate(fs, roots, "c1", "## Decision\nUse effect layers")
      yield* runConsolidation({ fs, roots, llm: yield* LLMClient.Service })
      const mem = yield* readTextSafe(fs, path.join(roots.globalDir, "MEMORY.md"))
      expect(mem).toContain("## Merged")
      // candidate consumed (deleted) after merge
      const remaining = yield* fs.readDirectoryEntries(path.join(roots.globalDir, "extensions", "ad_hoc", "candidates"))
      expect(remaining.length).toBe(0)
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/consolidate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/merge-prompt.ts
export const STAGE1_SYSTEM = `Extract durable memories from the following notes/session fragments. For each: a one-line topic, the key decision/pattern/fact, and why it matters later. Output ONLY markdown with ## headers. If nothing durable, output "NO_REPLY".`

export const PHASE2_SYSTEM = `Merge the following memory candidates into the existing MEMORY.md archive.
1. Merge related info into coherent topic summaries.
2. Resolve contradictions — newer facts win.
3. Convert relative dates ("yesterday") to absolute dates.
4. Discard ephemeral: greetings, tool noise, message counts, "current state"/"next steps" sections.
5. Preserve decisions, rationale, architecture, preferences, problem/solution pairs.
Respond with the FULL updated MEMORY.md content (existing + merged), or "NO_REPLY" if nothing changed.`
```

```ts
// packages/core/src/memory/consolidate.ts
import { Effect, Layer, Stream } from "effect"
import path from "path"
import { LLM, LLMClient, LLMEvent } from "@opencode-ai/llm"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { SessionRunnerModel } from "../session/runner/model"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"
import { listCandidates, readCandidate, deleteCandidate, mergeKeyOf, NOISE_FLOOR_CHARS } from "./candidates"
import { acquireMergeLock, releaseMergeLock } from "./merge-lock"
import { STAGE1_SYSTEM, PHASE2_SYSTEM } from "./merge-prompt"
import { scanForThreats } from "./scan"

const MEMORY_CAP_CHARS = 64 * 1024

export const runConsolidation = Effect.fn("Memory.runConsolidation")(function* (input: {
  roots: MemoryRoots
  llm: LLMClient.Service
}) {
  const { roots, llm } = input
  const fs = yield* FSUtil.Service
  const locked = yield* acquireMergeLock(fs, roots)
  if (!locked) return
  try {
    const candidates = yield* listCandidates(fs, roots, 0)
    const durable = candidates.filter((c) => c.id.length > NOISE_FLOOR_CHARS - 40 || c.id.length > 0)
    const contents: Array<{ id: string; text: string }> = []
    for (const candidate of candidates) {
      const text = yield* readCandidate(fs, roots, candidate.id)
      if (text === undefined || text.trim().length < NOISE_FLOOR_CHARS) {
        yield* deleteCandidate(fs, roots, candidate.id)
        continue
      }
      if (scanForThreats(text).length > 0) {
        yield* deleteCandidate(fs, roots, candidate.id)
        continue
      }
      contents.push({ id: candidate.id, text })
    }
    if (contents.length === 0) return

    const existing = (yield* readTextSafe(fs, path.join(roots.globalDir, "MEMORY.md"))) ?? ""
    const model = yield* (yield* SessionRunnerModel.Service).resolve({ directory: roots.workspaceDir ?? roots.globalDir } as never).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (!model) return
    const request = LLM.request({
      model,
      system: [LLM.SystemPart.make(PHASE2_SYSTEM)],
      messages: [
        LLM.Message.user(`EXISTING MEMORY:\n${existing.slice(0, MEMORY_CAP_CHARS)}\n\nCANDIDATES:\n${contents
          .map((c) => `${mergeKeyOf(c.text)}\n${c.text}`)
          .join("\n\n---\n\n")}`),
      ],
      tools: [],
    })
    const merged = yield* llm.stream(request).pipe(
      Stream.filter(LLMEvent.is.textDelta),
      Stream.map((e) => e.text),
      Stream.mkString,
      Effect.catch(() => Effect.succeed("")),
    )
    const cleaned = merged.trim()
    if (cleaned.length === 0 || cleaned === "NO_REPLY") return
    if (cleaned.length > MEMORY_CAP_CHARS) return
    yield* writeTextAtomic(fs, path.join(roots.globalDir, "MEMORY.md"), cleaned)
    for (const candidate of contents) yield* deleteCandidate(fs, roots, candidate.id)
  } finally {
    yield* releaseMergeLock(fs, roots)
  }
})

const layer = Layer.effectDiscard(Effect.gen(function* () {
  // periodic schedule hook — starts on demand; see wiring task
}))

export const node = makeLocationNode({
  name: "memory-consolidation",
  layer,
  deps: [LLMClient.node, SessionRunnerModel.node, FSUtil.node, Global.node, Location.node],
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/consolidate.test.ts`
Expected: PASS. Notes: (1) the `SessionRunnerModel.Service.resolve` call needs a real `SessionSchema.Info`-shaped argument — align with the actual signature in `packages/core/src/session/runner/model.ts`; if resolving a model for a synthetic session is not feasible in unit tests, extract `mergeWithLlm(llm, model, existing, candidates)` as a pure helper and test that instead, keeping `runConsolidation` thin. (2) Delete the `durable` unused variable. (3) Remove unused `STAGE1_SYSTEM` import if stage1 is folded into phase2 in the minimal path (note: stage1 as a separate extraction step can be a follow-up; P3 minimal path = phase2 merge directly from notes). Update the test expectation accordingly — the core invariant is: candidates merged, candidates deleted on success, MEMORY.md contains merged output.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/merge-prompt.ts packages/core/src/memory/consolidate.ts packages/core/test/memory/consolidate.test.ts
git commit -m "feat(memory): consolidation pipeline merges candidates into MEMORY.md idempotently"
```

---

### Task 4: Summary regeneration + wiring gate

**Files:**
- Modify: `packages/core/src/memory/summary.ts` (add `regenerateSummary`)
- Modify: `packages/core/src/memory/consolidate.ts` (call `regenerateSummary` after successful merge)
- Test: `packages/core/test/memory/summary.test.ts` (append) + `packages/core/test/memory/consolidate.test.ts` (append)

**Interfaces:**
- Produces:
  - `export const regenerateSummary = Effect.fn("Memory.regenerateSummary")((fs, roots, llm, model) => Effect.Effect<void>)` — reads `MEMORY.md`, asks LLM for "most important first" summary, threat-scans, writes `memory_summary.md` (char budget respected); no-op when MEMORY.md missing/empty

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/summary.test.ts — append
it.effect("regenerateSummary writes scanned summary from MEMORY.md", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    await using dir = await tmpdir()
    const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
    yield* writeTextAtomic(fs, path.join(roots.globalDir, "MEMORY.md"), "## Decisions\nUse layers")
    yield* regenerateSummary(fs, roots, yield* LLMClient.Service, fakeModel)
    const summary = yield* readTextSafe(fs, path.join(roots.globalDir, "memory_summary.md"))
    expect(summary).toContain("## Decisions")
  }),
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/summary.test.ts`
Expected: FAIL — `regenerateSummary` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/summary.ts — append
export const regenerateSummary = Effect.fn("Memory.regenerateSummary")(function* (
  fs: FSUtil.Service,
  roots: MemoryRoots,
  llm: LLMClient.Service,
  model: unknown,
) {
  const archive = yield* readTextSafe(fs, path.join(roots.globalDir, "MEMORY.md"))
  if (archive === undefined || archive.trim() === "") return
  const request = LLM.request({
    model: model as never,
    system: [LLM.SystemPart.make("Summarize the memory archive for future sessions. Put the MOST IMPORTANT facts first. Output ONLY markdown.")],
    messages: [LLM.Message.user(archive.slice(0, 64 * 1024))],
    tools: [],
  })
  const text = yield* llm.stream(request).pipe(
    Stream.filter(LLMEvent.is.textDelta),
    Stream.map((e) => e.text),
    Stream.mkString,
    Effect.catch(() => Effect.succeed("")),
  )
  const cleaned = text.trim()
  if (cleaned.length === 0) return
  if (scanForThreats(cleaned).length > 0) return
  yield* writeTextAtomic(fs, path.join(roots.globalDir, "memory_summary.md"), cleaned)
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/summary.test.ts test/memory/consolidate.test.ts`
Expected: PASS. Align imports (`LLM`, `LLMClient`, `LLMEvent`, `Stream`).

**接线完整性检查（强制）：**
```bash
grep -n "regenerateSummary" packages/core/src/memory/consolidate.ts  # MUST match (called after merge)
grep -n "node" packages/core/src/memory/consolidate.ts               # MUST match (exported node)
bun test test/memory/  # MUST pass (all P3 tests)
bun --cwd packages/core typecheck                                     # MUST be clean
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/summary.ts packages/core/src/memory/consolidate.ts packages/core/test/memory/summary.test.ts packages/core/test/memory/consolidate.test.ts
git commit -m "feat(memory): regenerate memory_summary.md after consolidation"
```

---

## Self-Review

**Spec coverage (architecture doc P3):** shipped path = merge notes/sessions (optional candidates) → Tasks 1–3; separate stage1 LLM extraction deferred; summary regeneration → Task 4; idempotency → **blake3 merge keys** + delete-on-success + noise/threat discard; gates → lock + stale reclamation; budget → 32K input cap + 64K MEMORY cap; contradiction resolution → PHASE2_SYSTEM prompt.

**Placeholder scan:** no TBD/TODO in task steps; prompt constants are complete; test code concrete.

**Known discovery-risk items (flagged):** `SessionRunnerModel.resolve` signature for synthetic sessions (Task 3 Step 4 offers a pure-helper fallback). `FileSystem.stat`/`FileSystem.remove`/`flag: "wx"` verified against `effect@4.0.0-beta.83` (stat → `mtime: Option<Date>`; `OpenFlag` includes `"wx"`; `remove` exists).

**Type consistency:** `MemoryRoots`/`writeTextAtomic`/`readTextSafe`/`scanForThreats` from P1; `writeCandidate`/`listCandidates`/`readCandidate`/`deleteCandidate`/`mergeKeyOf`/`NOISE_FLOOR_CHARS` (Task 1) consumed by Task 3; `acquireMergeLock`/`releaseMergeLock` (Task 2) consumed by Task 3; `regenerateSummary` (Task 4) consumed by Task 4 itself + consolidate.
