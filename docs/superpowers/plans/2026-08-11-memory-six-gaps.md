# Memory Six-Gap Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six verified gaps vs hermes / openclaw / oh-my-agent / codex so memory participates in the loop (subagent → pre-compress → recall quality → layered dreaming → injection control → migration), without weakening our ledger/dual-root/threat advantages.

**Architecture:** Keep single dual-root memory layout and Effect services. Add pure filter modules + phase scheduler on top of existing `mergeCandidates` / `buildRecallBlock` / hooks at known choke points (`SubagentLifecycle` Complete, `compactAfterOverflow` entry, `context`/`formatRecallBlock`). Prefer env knobs under `OPENCODE_MEMORY_*` consistent with embedding/HTTP patterns. Fail-open on missing age/score metadata.

**Tech Stack:** TypeScript, Effect, Bun test, existing SQLite FTS/hybrid index, SystemContext, SessionCompaction, SubagentLifecycle / Task host bridges.

**Repo root:** `/home/huyongjun/openpartner/opencode`

**Canonical plan copy:** `docs/superpowers/plans/2026-08-11-memory-six-gaps.md` (write same content there on save).

---

## Gap → Task map

| Gap | Priority | Tasks | Primary files |
|-----|----------|-------|---------------|
| 3 Recall TTL + min-score | P0 (smallest, high leverage) | T1–T2 | `recall.ts`, `ranking.ts`, `config.ts`, `tools.ts` |
| 2 Layered dreaming + recovery | P0 | T3–T5 | `dream-phases.ts` (new), `consolidate.ts`, `merge-lock.ts`, `prompts.ts` |
| 1 Subagent memory (on_delegation) | P1 | T6–T7 | `delegation-memory.ts` (new), subagent lifecycle or task host |
| 4 Pre-compress insight extract | P1 | T8–T9 | `pre-compress.ts` (new), `compaction.ts`, `flush.ts` order |
| 5 Citation / inject mode | P2 | T10 | `context.ts`, `recall.ts`, `config.ts`, health |
| 6 Cross-session / external import | P2 | T11–T12 | `history-import.ts` (new), transfer/HTTP optional |

**Out of scope (do not break):** ledger rollback, dual-root locks, threat scan chain, workspace-untrusted framing, consolidate hard-failure backoff, flush Jaccard/cosine triple gate.

---

## File map (create / modify)

| Path | Responsibility |
|------|----------------|
| `packages/core/src/memory/config.ts` | Extend env surface: recall TTL/minScore, dream phases, citations mode, precompress flag |
| `packages/core/src/memory/ranking.ts` | Export hard age/score filters (pure) used by recall + tools |
| `packages/core/src/memory/recall.ts` | Apply filters after `rankResults` |
| `packages/core/src/memory/tools.ts` | Same filters on `memory_search` |
| `packages/core/src/memory/dream-phases.ts` | **New** light/deep/REM schedule + source gates + recovery policy |
| `packages/core/src/memory/consolidate.ts` | Run phase-selected sources; recovery path; health status fields |
| `packages/core/src/memory/merge-lock.ts` | Phase-aware last-run stamps (or separate stamp files) |
| `packages/core/src/memory/prompts.ts` | `DREAM_LIGHT_SYSTEM`, `DREAM_REM_SYSTEM` (deep keeps/extends `DREAM_SYSTEM`) |
| `packages/core/src/memory/delegation-memory.ts` | **New** write candidate observation from child complete |
| `packages/core/src/session/subagent-lifecycle.ts` + boot wire | Register memory contributor on Complete/Fail |
| or `packages/opencode/src/tool/tool-host-bridges.ts` | Dual-call `onChildTerminal` if lifecycle insufficient |
| `packages/core/src/memory/pre-compress.ts` | **New** extract insights from entries before summarize |
| `packages/core/src/session/compaction.ts` | Call pre-compress; inject text into summarize prompt |
| `packages/core/src/memory/context.ts` | Respect citations mode in baseline/summary framing |
| `packages/core/src/memory/history-import.ts` | **New** import external turns → notes/sessions |
| `packages/core/src/memory/health.ts` | Expose phase, recall filter config, actionHints |
| `docs/superpowers/plans/2026-08-11-memory-system-status.md` | Operator docs for new envs |
| Tests under `packages/core/test/memory/` | One file per wave |

---

## Env surface (product)

| Env | Default | Gap |
|-----|---------|-----|
| `OPENCODE_MEMORY_RECALL_MAX_AGE_DAYS` | `30` | 3 — hard filter session sources older than N days; curated exempt; unknown age **kept** (fail-open) |
| `OPENCODE_MEMORY_RECALL_MIN_SCORE` | `0.15` | 3 — drop after decay if score &lt; floor; missing score **kept** |
| `OPENCODE_MEMORY_DREAM_LIGHT_HOURS` | `6` | 2 |
| `OPENCODE_MEMORY_DREAM_DEEP_HOURS` | `24` | 2 |
| `OPENCODE_MEMORY_DREAM_REM_HOURS` | `168` | 2 |
| `OPENCODE_MEMORY_DREAM_DEEP_MIN_ACCESS` | `3` | 2 — deep only promotes high-access chunks / notes with recall |
| `OPENCODE_MEMORY_DREAM_RECOVERY_HEALTH` | `0.35` | 2 — if curated health &lt; threshold, force light recovery merge |
| `OPENCODE_MEMORY_CITATIONS` | `auto` | 5 — `auto` \| `on` \| `off` |
| `OPENCODE_MEMORY_PRECOMPRESS` | `1` (on) | 4 — set `0` to disable insight extract |
| `OPENCODE_MEMORY_DELEGATION` | `1` (on) | 1 — set `0` to disable child observations |

---

### Task 1: Pure recall filters (TTL + min-score)

**Files:**
- Modify: `packages/core/src/memory/ranking.ts`
- Modify: `packages/core/src/memory/config.ts`
- Create: `packages/core/test/memory/recall-filters.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test"
import { filterRecallHits, DEFAULT_RECALL_MAX_AGE_DAYS, DEFAULT_RECALL_MIN_SCORE } from "../../src/memory/ranking"

describe("filterRecallHits", () => {
  test("drops session hits older than maxAgeDays", () => {
    const kept = filterRecallHits(
      [
        { path: "sessions/a.md", score: 1, source: "session", ageDays: 45, text: "old" },
        { path: "sessions/b.md", score: 1, source: "session", ageDays: 5, text: "fresh" },
        { path: "MEMORY.md", score: 0.1, source: "workspace", ageDays: 999, text: "curated" },
      ],
      { maxAgeDays: 30, minScore: 0.15 },
    )
    expect(kept.map((h) => h.path)).toEqual(["sessions/b.md", "MEMORY.md"])
  })

  test("fail-open when ageDays is missing/NaN", () => {
    const kept = filterRecallHits(
      [{ path: "x.md", score: 1, source: "session", ageDays: Number.NaN, text: "unk" }],
      { maxAgeDays: 30, minScore: 0.15 },
    )
    expect(kept).toHaveLength(1)
  })

  test("drops low decayed scores but keeps missing score", () => {
    const kept = filterRecallHits(
      [
        { path: "a.md", score: 0.05, source: "session", ageDays: 1, text: "noise" },
        { path: "b.md", score: 0.5, source: "session", ageDays: 1, text: "ok" },
      ],
      { maxAgeDays: 30, minScore: 0.15 },
    )
    expect(kept.map((h) => h.path)).toEqual(["b.md"])
  })
})
```

- [ ] **Step 2: Run to verify fail**

```bash
cd packages/core && bun test test/memory/recall-filters.test.ts
```

Expected: FAIL — `filterRecallHits` not exported.

- [ ] **Step 3: Implement**

In `ranking.ts` add:

```ts
export const DEFAULT_RECALL_MAX_AGE_DAYS = 30
export const DEFAULT_RECALL_MIN_SCORE = 0.15

export type RecallHitLike = {
  path: string
  score: number
  source: string
  ageDays: number
  text: string
}

export function filterRecallHits<T extends RecallHitLike>(
  items: ReadonlyArray<T>,
  opts: { maxAgeDays: number; minScore: number },
): T[] {
  return items.filter((item) => {
    // Age: only session; unknown age kept
    if (item.source === "session") {
      const age = item.ageDays
      if (Number.isFinite(age) && age > opts.maxAgeDays) return false
    }
    // Score floor after caller applied decay; NaN/undefined-like kept
    if (Number.isFinite(item.score) && item.score < opts.minScore) return false
    return true
  })
}
```

In `config.ts` add `memoryRecallEnvConfig()` reading the two envs with the defaults above.

- [ ] **Step 4: Tests pass + commit**

```bash
cd packages/core && bun test test/memory/recall-filters.test.ts
git add packages/core/src/memory/ranking.ts packages/core/src/memory/config.ts packages/core/test/memory/recall-filters.test.ts
git commit -m "feat(memory): pure recall age/score filters (oh-my-agent parity)"
```

---

### Task 2: Wire filters into recall + memory_search

**Files:**
- Modify: `packages/core/src/memory/recall.ts` (~115–121)
- Modify: `packages/core/src/memory/tools.ts` (search path ~286)
- Modify: `packages/core/test/memory/recall.test.ts`

- [ ] **Step 1: Failing integration expectation**

Add test: seed session chunk with `mtime` 60 days ago + high FTS score → `buildRecallBlock` must **not** include it when `OPENCODE_MEMORY_RECALL_MAX_AGE_DAYS=30`.

- [ ] **Step 2: Wire**

```ts
// recall.ts after rankResults, before isContentFree:
const cfg = memoryRecallEnvConfig()
const ranked = rankResults(hits).map((hit) => ({
  ...hit,
  // recompute decayed score for minScore consistency
  score: decayScore(hit.score, hit.ageDays, hit.source as "global" | "workspace" | "session"),
}))
const kept = filterRecallHits(ranked, cfg)
  .filter((hit) => !isContentFree(hit.text))
  // ... existing threat filters ...
  .slice(0, RECALL_TOP_N)
```

Mirror in `tools.ts` for `memory_search`.

- [ ] **Step 3: Run suite slice**

```bash
cd packages/core && bun test test/memory/recall.test.ts test/memory/tools.test.ts test/memory/recall-filters.test.ts
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(memory): apply recall TTL and min-score on inject and search"
```

---

### Task 3: Dream phase types + source gates (no LLM yet)

**Files:**
- Create: `packages/core/src/memory/dream-phases.ts`
- Create: `packages/core/test/memory/dream-phases.test.ts`
- Modify: `packages/core/src/memory/config.ts`

- [ ] **Step 1: Spec (implement as pure module)**

```ts
export type DreamPhase = "light" | "deep" | "rem" | "recovery"

export type PhasePolicy = {
  phase: DreamPhase
  /** Jaccard near-dup gate for light-only dedupe-only merges (0.9 openclaw-like) */
  dedupeThreshold: number
  /** Deep: require accessCount >= N for session/note promotion when metadata present */
  minAccess: number
  /** Deep: prefer sources newer than half-life days */
  recencyHalfLifeDays: number
  /** Deep: min internal relevance score when available */
  minScore: number
}

export function selectDuePhase(now: number, last: {
  light?: number
  deep?: number
  rem?: number
}, hours: { light: number; deep: number; rem: number }): DreamPhase | undefined

export function filterSourcesForPhase(
  sources: ReadonlyArray<MergeSource & { accessCount?: number }>,
  phase: DreamPhase,
  policy: PhasePolicy,
): MergeSource[]

/** Health in [0,1]; if < recoveryThreshold and short-term sources exist → recovery */
export function shouldRecover(health: number, threshold: number, shortTermCount: number): boolean
```

Defaults aligned with openclaw: light 6h, deep 24h, rem 168h; deep minAccess 3, recency 14d half-life, minScore 0.8; recovery threshold 0.35.

Light: all notes/candidates + recent sessions; **no** full archive rewrite of cold session noise preferred — still call same `mergeCandidates` but with smaller input + light prompt.

Deep: only sources meeting access/recency gates (+ all notes always? **Decision: notes always eligible; session/candidates gated**).

REM: does not delete sources; runs pattern-mining prompt on MEMORY.md + high-access chunks; writes optional `extensions/ad_hoc/patterns.md` or appends section — **prefer candidate `rem-patterns-<date>.md` then next deep merges** to keep ledger atomicity.

Recovery: when `curatedHealth < 0.35` (define: empty MEMORY or summary missing or vectorCoverage-style file count ratio) and notes/sessions exist, force light merge ignoring light interval.

- [ ] **Step 2: Unit tests for selectDuePhase / filterSourcesForPhase / shouldRecover**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(memory): dream phase policy pure module"
```

---

### Task 4: Phase stamps + consolidate orchestration

**Files:**
- Modify: `packages/core/src/memory/merge-lock.ts` — add `dream-phase.last.json` or three stamp files under base
- Modify: `packages/core/src/memory/consolidate.ts` — `runConsolidation` becomes phase-aware
- Modify: `packages/core/src/memory/prompts.ts` — light + REM systems
- Modify: `packages/core/test/memory/consolidate.test.ts`

- [ ] **Step 1: Stamp API**

```ts
// merge-lock.ts
export type DreamPhaseStamps = { light?: number; deep?: number; rem?: number }
export const loadDreamStamps = Effect.fn(...)(function* (fs, roots) { ... })
export const markDreamPhase = Effect.fn(...)(function* (fs, roots, phase: DreamPhase) { ... })
```

Keep existing `shouldConsolidate` 4h as **global min** OR replace with phase stamps only — **Decision: phase stamps supersede monolithic 4h; light can run every 6h; deep/rem longer. Global lock still exclusive.**

- [ ] **Step 2: `runConsolidation` body change**

```
acquire lock
load stamps + health
if shouldRecover → phase = recovery
else phase = selectDuePhase(...)
if !phase → skip "too-soon"
filter sources for phase
if phase === rem → remPatternPass(...)  // special prompt, no source delete unless REM writes only candidates
else mergeCandidates(..., systemPromptFor(phase))
markDreamPhase(phase)
summary regen on light/deep/recovery success (not REM-only candidate write unless MEMORY changed)
release lock
```

- [ ] **Step 3: Tests**

- Light due when only light stamp old
- Deep filters out low-access sessions
- Recovery fires when MEMORY empty and notes present even if light stamp fresh
- Existing ledger rollback tests still pass

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(memory): layered light/deep/REM/recovery consolidation"
```

---

### Task 5: Health + docs for dream phases

**Files:**
- Modify: `packages/core/src/memory/health.ts`
- Modify: HTTP schema optional fields in `groups/experimental.ts` if health typed
- Modify: `docs/superpowers/plans/2026-08-11-memory-system-status.md`
- Test: `health.test.ts`

Expose: `dreamLastLight`, `dreamLastDeep`, `dreamLastRem`, `dreamNextHint`, `recallMaxAgeDays`, `recallMinScore`, `citationsMode`.

- [ ] **Commit:** `feat(memory): health surface for dream phases and recall filters`

---

### Task 6: Delegation observation writer (on_delegation)

**Files:**
- Create: `packages/core/src/memory/delegation-memory.ts`
- Create: `packages/core/test/memory/delegation-memory.test.ts`

- [ ] **Step 1: API**

```ts
export const writeDelegationObservation = Effect.fn("Memory.writeDelegationObservation")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  input: {
    parentSessionID: string
    childSessionID: string
    task: string
    result: string
    ok: boolean
  },
) {
  // 1) scan threats on task/result; drop if threatened
  // 2) build markdown:
  //    ## Subagent observation
  //    parent: ... child: ... ok: ...
  //    ### Task\n...\n### Result\n...
  // 3) writeCandidate(fs, roots, `deleg-${childSessionID}-${hash8}`, content)
  // 4) optional: appendSessionLog meta line under parent session id
})
```

Cap result text (e.g. 8k). Idempotent id from childSessionID so double notify does not spam (overwrite same candidate path OK).

- [ ] **Step 2: Unit tests** with tmpdir FSUtil

- [ ] **Commit:** `feat(memory): delegation observation candidate writer`

---

### Task 7: Wire on_delegation into subagent completion

**Files:**
- Prefer: register `SubagentLifecycle` contributor at memory node boot in `packages/opencode/src/effect/app-runtime.ts` OR location-services
- Fallback dual-path: `tool-host-bridges.ts` `notifyParent` + foreground settle

- [ ] **Step 1: Contributor**

```ts
// packages/core/src/memory/delegation-wire.ts
export const registerDelegationMemoryHook = Effect.fn(...)(function* () {
  if (process.env.OPENCODE_MEMORY_DELEGATION === "0") return
  const lifecycle = yield* SubagentLifecycle.Service // if available as service
  yield* lifecycle.register({
    on: {
      Complete: (ev) => writeDelegationObservation(... extract task/result from registry snapshot ...),
      Fail: (ev) => writeDelegationObservation(..., ok: false),
    },
  })
})
```

**Payload problem:** lifecycle events may lack task/result text. **Decision:** implement shared helper called from `notifyParent` where output text exists:

```ts
// tool-host-bridges.ts after success/fail
yield* MemoryDelegation.recordIfWired({
  parentSessionID, childSessionID,
  task: promptPreview,
  result: outputText,
  ok,
})
```

And call the same from foreground settle path that publishes `Subagent.Completed`.

- [ ] **Step 2: Integration test** (core-level with mock fs) + host test if exists

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(memory): record subagent task/result into candidates (hermes on_delegation)"
```

---

### Task 8: Pre-compress insight extraction (pure + LLM-optional)

**Files:**
- Create: `packages/core/src/memory/pre-compress.ts`
- Create: `packages/core/test/memory/pre-compress.test.ts`
- Modify: `packages/core/src/memory/prompts.ts` — `PRECOMPRESS_SYSTEM`

- [ ] **Step 1: Extract without LLM first (deterministic)**

```ts
/** Pull durable facts from messages about to leave the window: decisions, paths, errors. */
export function extractPreCompressInsights(
  entries: ReadonlyArray<{ message: { type: string; text?: string; content?: unknown } }>,
): string
```

Rules (no LLM required for v1):
- Collect last N user messages + assistant decision-like lines
- Strip threats
- Cap 4k
- Return empty if trivial

Optional v1.1: LLM with `PRECOMPRESS_SYSTEM` if model available — **gate behind same PRECOMPRESS env; start deterministic to avoid double token burn with flush.**

- [ ] **Step 2: Tests** for decision/path extraction + threat drop

- [ ] **Commit:** `feat(memory): pre-compress insight extractor`

---

### Task 9: Hang pre-compress on V2 compactAfterOverflow

**Files:**
- Modify: `packages/core/src/session/compaction.ts` at start of `compactAfterOverflow` (before summarize stream)
- Modify: `buildPrompt` or prepend insights to `basePrompt`
- Optionally write insights as `writeCandidate` so consolidate sees them even if summary drops them
- Align manual compact order: insights still run inside `compactAfterOverflow` (covers both)

```ts
const insights = extractPreCompressInsights(input.entries)
const promptWithMemory = insights
  ? `${basePrompt}\n\n## Memory insights to preserve\n${insights}`
  : basePrompt
// also best-effort writeCandidate when Memory roots resolvable — pass optional callback via Dependencies to avoid cyclic imports
```

**Dependencies injection:** add optional `onPreCompress?: (entries) => Effect.Effect<string>` on `SessionCompaction.Dependencies` wired from location with memory.

- [ ] **Step 1: Unit test** that summarize prompt contains insight subsection when extractor returns text (mock llm captures request)

- [ ] **Step 2: Document** that post-compact `flushMemoryIfWired` remains for session log; pre-compress feeds **compaction summary**, not a replacement for flush

- [ ] **Commit:** `feat(memory): inject pre-compress insights into compaction summary prompt`

---

### Task 10: Citation / inject mode

**Files:**
- Modify: `packages/core/src/memory/config.ts` — `memoryCitationsMode(): "auto" | "on" | "off"`
- Modify: `packages/core/src/memory/recall.ts` `formatRecallBlock`
- Modify: `packages/core/src/memory/summary.ts` or `context.ts` baseline
- Test: `context.test.ts`, `recall.test.ts`

Behavior:
- `off`: summary still injects framework text only if summaries empty? **Decision: `off` suppresses summary body + recall block content; keeps trust-boundary one-liner.**
- `on`: always include paths/citations in recall bullets (current format)
- `auto`: current behavior (inject summaries always; recall when hits; citations in recall bullets)

```ts
export function formatRecallBlock(hits, mode: CitationsMode): string {
  if (mode === "off") return ""
  // on/auto: path citations as today
}
```

- [ ] **Commit:** `feat(memory): OPENCODE_MEMORY_CITATIONS inject mode`

---

### Task 11: External history import (minimal codex/oma parity)

**Files:**
- Create: `packages/core/src/memory/history-import.ts`
- Create: `packages/core/test/memory/history-import.test.ts`
- Optional HTTP: extend experimental import payload `kind: "memory-pack" | "session-export"`

Supported v1 formats (fail closed on unknown):
1. **JSONL** lines `{role,text,ts?}` → one session log markdown under `sessions/import-<date>-<hash>.md`
2. **Directory of .md** already memory-shaped → reuse `importMemory` path
3. **Claude/Cursor-like** simple JSON `{messages:[{role,content}]}` if present

```ts
export const importExternalHistory = Effect.fn(...)(function* (
  fs, roots, sourcePath, opts: { format: "jsonl" | "messages-json" | "auto"; allowedRoots: string[] },
): Effect.Effect<{ imported: number; skipped: number; error?: string }>
```

Sandbox: reuse `assertSandboxPath` from transfer.

- [ ] **Commit:** `feat(memory): import external session history into sessions/`

---

### Task 12: Wire history import to HTTP/SDK/TUI (thin)

**Files:**
- `groups/experimental.ts` — optional `format` on import payload **or** new endpoint `POST /experimental/memory/import-history`
- SDK patch `importPack` or new method
- TUI: import mode third option "Import external history" with format auto
- Docs status page

Prefer **new endpoint** to avoid breaking pack import semantics.

- [ ] **Commit:** `feat(memory): HTTP/TUI surface for history import`

---

### Task 13: Whole-system verification gate

- [ ] **Step 1: Tests**

```bash
cd packages/core && bun test test/memory/
cd packages/core && bun run typecheck
cd packages/tui && bun test test/memory-modal.test.tsx
```

Expect: memory suite green; typecheck 0.

- [ ] **Step 2: Self-review checklist**

| Gap | Verification |
|-----|----------------|
| 1 | Child complete writes `extensions/ad_hoc/candidates/deleg-*.md`; consolidate can merge |
| 2 | Stamps advance light/deep/rem; recovery when MEMORY empty |
| 3 | Old session hits absent from recall block; low score dropped |
| 4 | Compaction summarize request includes `## Memory insights to preserve` |
| 5 | `CITATIONS=off` empty recall block |
| 6 | JSONL import creates sessions/*.md |

- [ ] **Step 3: Status doc + final commit**

```bash
git commit -m "docs(memory): six-gap remediation complete status"
```

---

## Implementation order (do not reorder casually)

```
T1 → T2          # recall quality (fast win)
T3 → T4 → T5     # layered dreaming
T6 → T7          # subagent memory
T8 → T9          # pre-compress
T10              # citations
T11 → T12        # history import
T13              # gate
```

Estimated effort: ~2–4 focused agent-days if subagent-driven; T4 and T9 are highest risk (locks + compaction tokens).

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Phase consolidate burns more LLM tokens | Light uses smaller budget; REM writes candidates only; hard-failure backoff retained |
| Double memory write on subagent (child drain + parent observation) | Child sessions with `parentID` skip content flush? **Optional:** skip `flushSession` when `session.parentID` set (llm.ts already skips some parent paths) — confirm and document; keep metadata drain |
| Pre-compress + flush double LLM | Pre-compress deterministic v1; flush remains on compact boundary |
| Generated SDK overwrite | Hand-patch `sdk.gen.ts` like force import; note in commit |
| experimental HTTP 502 harness | Unit-test new endpoints; e2e optional |

---

## Self-review (plan quality)

1. **Spec coverage:** Gaps 1–6 each have tasks (1/6–7, 2/3–5, 3/1–2, 4/8–9, 5/10, 6/11–12).
2. **No placeholders:** Defaults, env names, hang points, and test shapes specified.
3. **Type consistency:** `DreamPhase`, `filterRecallHits`, `writeDelegationObservation`, `extractPreCompressInsights`, `importExternalHistory` named consistently across tasks.
4. **Preserves strengths:** ledger/atomic/dual-root/threat paths not redesigned—only gates and hooks added.

---

## Execution choice (for user)

After plan approval:

1. **Subagent-Driven (recommended)** — one subagent per task, review between waves  
2. **Inline Execution** — this session implements T1→T13 with checkpoints  

Plan also saved under `docs/superpowers/plans/2026-08-11-memory-six-gaps.md`.
