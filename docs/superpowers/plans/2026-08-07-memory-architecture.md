# Memory System — Complete Architecture (P1–P8)

> **Status:** **FULL remediation 2026-08-10 landed.** Architecture reference (locked contracts below). Phase plans: `2026-08-07-memory-system-p{1..8}.md`. FULL plan: `2026-08-10-memory-full-remediation.md`. Status evidence: `2026-08-10-memory-full-status.md`. Updated 2026-08-07 after plan review (access_count, dual-root index, workspace capture, dual-injection); re-synced 2026-08-10 for sources-model consolidation, dual-root dream, Global drain poller, hybrid config, transfer sandbox, and journey e2e gate.

**Goal:** A mature cross-session memory system for opencode: layered storage, scanned+truncated injection, retrieval with quality ranking, automated capture, and asynchronous consolidation — built from the Grok (storage/retrieval quality) × Codex (injection/write discipline) hybrid.

**Architecture principles (locked):**
1. **写读分离**: agent writes notes/session logs only; curated `MEMORY.md` and injected `memory_summary.md` are only modified by consolidation (LLM) — never by the agent directly.
2. **注入契约（双通道）**: (a) `memory_summary.md` via SystemContext every prompt assembly (truncated, scanned); (b) epoch-only **recall** block (P6) of top-N retrieved chunks (scanned). Notes/session logs are never injected raw. Budgets: summary global 1500 + workspace 1000 tokens (chars≈4×); recall ≤4K chars. See [Injection contract](#injection-contract-locked).
3. **动态读 + 前缀缓存**: summary is re-read per model step (never frozen into the session record). Within a session, summary is expected stable; if consolidation regenerates `memory_summary.md` mid-session, prefix-cache invalidation is **accepted** (rare; consolidation is gated by min_hours). Recall is epoch-only (`initialize` / post-compaction `prepare`) so it does not churn mid-epoch.
4. **幂等巩固**: source notes/sessions/candidates deleted only after successful merge into `MEMORY.md` (or noise/threat discard); crash recovery = rescan sources (files ARE the job state). Idempotency ledger = `merged.hashes` (sha256 of `id\ntext`); optional HTML markers are best-effort only.
5. **隐私纪律**: automatic saves are metadata-only (zero LLM); content capture requires user trigger (note or flush).
6. **安全底线**: threat scan at note-write, summary-injection, **and recall-injection**; path triple-guard; exclusive `create_new` writes; atomic IO.
7. **容量管理**: `MEMORY.md` char budget + merge-time ephemeral discard + usage-based prune at **chunk/entry** granularity (P5), driven by `access_count` (P4).

## Locked contracts (plan-review fixes)

### Access count (P4 writes; P5/P8 consume)

| Event | Behavior |
|---|---|
| `memory_search` returns a hit | `access_count += 1` for that chunk id |
| P6 recall includes a chunk | `access_count += 1` |
| `memory_read` of a path that maps to indexed chunks | bump those chunks once per read call |
| Citation-only display without retrieval | no bump |

Prune/health **only** read `access_count`; never invent proxies. Missing increment path = plan defect.

### Dual-root index (Option A)

- Global root and workspace root each own an `index.sqlite` (gitignored, regenerable).
- `memory_search` / recall: query both when workspace exists; merge hits; then `rankResults` (workspace > global > session, then score).
- Corrupt/missing either index → search the other; both missing → P1 grep fallback.

### P2 capture scope

- Drain-end metadata watcher is a **Global poller** (`makeGlobalNode`) with **per-session roots** via `session.location.directory` → `resolveRoots(globalBase, directory)`. Workspace sessions write workspace `sessions/` when a project directory is set; otherwise global.
- Flush (compaction / on-demand) uses the same root resolution (`workspaceDir ?? globalDir`).
- Scope finalizer best-effort flushes pending idle sessions on shutdown. This replaces the earlier “location-node only” note while still avoiding a pure-global hole for project sessions.

### Injection contract (locked)

| Channel | When | Content | Scan | Budget |
|---|---|---|---|---|
| Summary | every SystemContext load | `memory_summary.md` only | yes | 1500+1000 tok |
| Recall | epoch initialize + post-compaction prepare | top-N ranked chunks | yes | ≤4K chars, N=5 |

"Single injection of raw notes" remains true; dual channel = curated summary + retrieved excerpts, both scanned.

### P3 consolidation path (FULL / sources model)

- **Shipped path:** `collectMergeSources()` reads **notes/** + **sessions/** + **candidates/** (legacy/crash buffer) ordered mtime-asc → budget slice → gated dream merge → write `MEMORY.md` → append **`merged.hashes`** (content-hash ledger) → delete only budget-included sources → regenerate `memory_summary.md`.
- Dual-root orchestration: with workspace open, consolidate workspace base then pure-global independently (separate locks).
- Separate LLM **stage1 extraction** remains optional (Wave H stretch); candidates are not required for the happy path.
- Idempotency: `sha256(stableSourceId + "\n" + content)` in `merged.hashes` is authoritative; HTML markers in MEMORY are best-effort only.

### Import policy (P8)

- Default: **never overwrite** an existing curated file that is **newer or equal** locally (keep local).
- Import only when local missing **or** imported mtime is strictly newer.
- `--force` (explicit) may overwrite; never the default.
- Every imported file is threat-scanned before becoming searchable.

### Non-goals (documented)

- Multi-process consolidation lock (single-process assumption; lock file + stale reclaim only).
- Subagent-private memory namespaces (share parent/project memory).
- Dedicated HTTP memory API beyond existing experimental surfaces if TUI needs them.
- LLM rewrite toggle in `/remember` (deferred).

## Data Flow (target end state)

```
WRITE PATH                          CONSOLIDATION PATH                  INJECTION PATH
┌─────────────┐   user ask    ┌──────────────┐
│ add_note    │ ────────────▶ │ notes/       │─┐
└─────────────┘               │ *.md         │ │
┌─────────────┐   drain end  ┌──────────────┐ │  collectMergeSources
│ session-end │ ────────────▶│ sessions/    │─┼─► budget → dream LLM ──► MEMORY.md
│ (metadata)  │              │ *.md         │ │      │ success            │ merged.hashes
└─────────────┘              └──────────────┘ │      ▼                   │
┌─────────────┐   compaction ┌──────────────┐ │  delete included    regenerate
│ flush       │ ────────────▶│ sessions/    │─┘  sources            memory_summary.md
│ (LLM)       │              │ (content)    │
└─────────────┘              └──────────────┘
  candidates/ = optional crash buffer only (not required happy path)

RETRIEVAL PATH                    ┌──────────────┐  ┌──────────────────────────┐
┌──────────┐  dual index (P4)    │ memory_sum-  │  │ SystemContext core/memory│
│ memory_* │ ──────────────────▶ │ mary.md      │─▶│ + epoch recall (P6)      │─▶ prompt
│ tools    │  FTS / hybrid (P7)  └──────────────┘  └──────────────────────────┘
└──────────┘  access_count++
```

## Storage Layout (locked)

```
~/.local/share/opencode/memory/           # GLOBAL (user-level; never in git)
├── memory_summary.md                     # injected (LLM-regenerated, P3)
├── MEMORY.md                             # curated archive (char budget)
├── index.sqlite                          # derived FTS (+ optional vec); gitignored
└── extensions/ad_hoc/notes/              # agent write zone (append-only)
<project>/.opencode/memory/               # WORKSPACE (committed: MEMORY.md + summary; ignored: notes/, sessions/, index)
├── memory_summary.md
├── MEMORY.md
├── index.sqlite
├── extensions/ad_hoc/notes/
└── sessions/YYYY-MM-DD-<id>.md           # session logs (P2 location watcher)
```

## Phase Definitions

### P1 — Minimal closed loop — PLAN: `2026-08-07-memory-system-p1.md`
Storage roots + scoped-path guards + threat scan + summary load/truncate + SystemContext injection + 4 tools + wiring (builtins, location-services, capability filter).

### P2 — Automatic capture + flush + citation — PLAN: `2026-08-07-memory-system-p2.md`
- **session-end metadata save** (zero-LLM): Global drain poller + per-session `location.directory` roots; workspace `sessions/` when project open; trivial-session skip (<3 prompts or <50 bytes); best-effort shutdown flush of pending idle sessions.
- **flush** (LLM): compaction + on-demand; title-model pattern; threat-scan before write; NO_REPLY + delta mode.
- **Citation**: search/read outputs carry path/line.
- **Wiring**: `memory-drain-watcher` Global node; flush → `context-engine.ts` compact path (`serviceOption`).

### P3 — Consolidation pipeline — PLAN: `2026-08-07-memory-system-p3.md` (+ FULL 2026-08-10)
- Gated merge (min_hours + lock + 32K input + 64K MEMORY cap); sources model notes+sessions+candidates; `merged.hashes` ledger; delete budget-included sources on success; dual-root orchestration; summary regeneration.
- Optional stage1 extraction deferred (Wave H); happy path does not require planting candidates.

### P4 — Retrieval quality (FTS5 + temporal decay) — PLAN: `2026-08-07-memory-system-p4.md`
- Dual-root `index.sqlite`; sha256 chunk dedup; **access_count increments on search/read/recall hits**; dirty reindex; temporal decay; grep fallback.

### P5 — Quality tooling + UI — PLAN: `2026-08-07-memory-system-p5.md`
- Prune candidates = **chunk ids** (low access + age), never whole-archive path alone; LLM-confirmed removal in merge.
- `/memory` modal; `/remember` is UX confirmation — **not** a security boundary (tool description remains the write gate for agent/CLI).

### P6 — Auto-recall — PLAN: `2026-08-07-memory-system-p6.md`
- Epoch-only relevance injection; threat-scanned; bumps access_count; `serviceOption`-gated.

### P7 — Vector retrieval — PLAN: `2026-08-07-memory-system-p7.md`
- Optional embeddings + hybrid 0.7/0.3 + MMR; full graceful degrade to P4 FTS.

### P8 — Final polish — PLAN: `2026-08-07-memory-system-p8.md`
- Health panel; export/import per import policy above; staleness marks on session chunks >14 days.
- **After P8: feature-complete.** Optional: P7 at scale, `/remember` LLM-rewrite toggle, MMR default on.

## Final-Form Acceptance Checklist (after P8 + FULL remediation)

- [x] Agent can write notes (user-request-gated via tool description) and retrieve via 4 tools with path/line citations.
- [x] Session-end metadata logs land in **workspace** `sessions/` when a project is open (Global drain poller + per-session roots); compaction flush captures content; citations present.
- [x] Notes/sessions merge into `MEMORY.md` idempotently (sha256 ledger `merged.hashes`, crash-safe); `memory_summary.md` regenerates; injected summary reflects knowledge. **Evidence:** `journey.e2e.test.ts`.
- [x] Dual-root FTS5 with temporal decay + content-free filtering; `access_count` increments on search/read/recall; auto-recall injects at session start and after compaction (scanned, budgeted).
- [x] Vector hybrid activates when embeddings configured; everything degrades without it (root-qualified hybrid ids + MMR).
- [x] Health shows real usage (dual-root walk + consolidate status); prune lists **chunk/entry** candidates into consolidation; export/import sandboxed and never-overwrite-newer-local; stale session memory marked.
- [x] No unsolicited memory writes; all injection scanned; budgets bounded; curated committed, runtime artifacts ignored.

## Global Invariants (every phase)

| Invariant | Enforced by |
|---|---|
| Agent never edits MEMORY.md/summary directly | only consolidation writes them (P3); P1/P2 tools are read-only + add_note |
| Injection never contains raw notes/sessions | summary + scanned recall excerpts only |
| No memory write without user request | tool description gate; P5 `/remember` is UX-only |
| Writes atomic + exclusive | create_new + temp-rename |
| Crash never loses notes | source deleted only after merge (P3) |
| Injection content scanned | threat scan at write + summary + recall |
| Budgets bounded | summary truncation (P1), recall 4K (P6), MEMORY.md cap (P3), prune (P5) |
| access_count drives prune/health | P4 increment contract |
| Dual-root indexes | P4 Option A |

## Open Questions (all resolved)

1. **P2 session-end signal**: polling watcher on `Execution.active` + 60s idle debounce; **location node → workspace sessions**.
2. **P3 LLM cost**: title-model pattern, min_hours=4, 32K input, 64K MEMORY; stage1 optional.
3. **P4 FTS5 location**: per-root `index.sqlite` gitignored (dual-root).
4. **P6 recall context**: wired at `SessionContextEpoch.initialize/prepare` in `llm.ts`.
5. **P7 embedding**: OpenAI-compatible `/embeddings`; sqlite-vec optional + JSON fallback.
6. **Access / dual inject / import**: locked in [Locked contracts](#locked-contracts-plan-review-fixes) above.
