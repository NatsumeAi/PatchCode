# Memory FULL Remediation — Status (2026-08-10)

> Acceptance gate evidence for `2026-08-10-memory-full-remediation.md` Wave G.
> Suite: `cd packages/core && bun test test/memory/` — **198 pass / 0 fail**.
>
> **Post-review remediation (2026-08-10):**
> - Must-fix (`c2a1549895`): sandbox symlink, pack symlink, NO_REPLY, short-note keep, remember scan, health rank, ledger keep, summary status.
> - Open P2 pass (`ee79c8af4a`): summary self-heal, hard-fail backoff, root-aware access/orphan, session-meta sanitize, FTS→grep fallback, dual-root export, drain TS fix.
> - Polish pass: Hermes-inspired scan+NFKC (F4), flush cycle generation + exact/near dedup (F14/F15), ledger-fail unit test.
> - **Prompt maturity pass:** FLUSH_DELTA=Grok-grade denoise, SUMMARY self-contained+NO_REPLY, PRUNE conservative, DECISION_FRAMEWORK Codex citation/verify matrix/ordering; delta gating only on `## Flush`.
> Optional later: embedding cosine dedup, Hermes full multi-scope threat catalog.
## Product journey (G1)

| Step | Result | Evidence |
|------|--------|----------|
| Empty dual roots | pass | `journey.e2e` setup via `resolveRoots` |
| `writeMemoryNote` (no `writeCandidate`) | pass | note under `extensions/ad_hoc/notes/` |
| Session log under `sessions/` | pass | durable content via `writeTextAtomic` |
| `runDualRootConsolidation` mock dream | pass | `MEMORY.md` contains decision |
| Sources deleted after success | pass | notes + sessions file counts 0 |
| `memory_summary.md` regen | pass | non-empty; contains Effect layers |
| `loadSummaries` + `renderSummaryBlock` | pass | workspace-memory block non-empty |
| `ensureIndexed` + search + `buildRecallBlock` | pass | hits / recall contain decision terms |
| Second consolidate no sources | pass | MEMORY + summary not wiped |

## Audit checklist (G4)

| Audit ID | Fixed in task | Evidence (test name) |
|----------|---------------|----------------------|
| P0 notes not consolidated | B4 | `journey.e2e` / consolidate note-only merge |
| P0 sessions not consolidated | B4 | consolidate session-only merge / `journey.e2e` |
| P0 export path sandbox | E1 | transfer-sandbox (assertSandboxPath + export/import fail closed) |
| P1 ranking inversion | A1 | ranking equal undecayed scores workspace > global > session |
| P1 deletePath IN | A2 | reindex multi-chunk deletePath / multi-chunk access |
| P1 atomic ignore | A3 | storage writeTextAtomic false on rename fail; session-logs append returns false |
| P1 session id collision | A4 | session-logs distinct ids / full sanitized id in filename |
| P1 multi-process append | A4 | session-logs append lock + serialize; single-writer assumption documented |
| P1 prune curated | B6 | prune isPrunablePath excludes MEMORY/summary; consolidate prune list omits curated |
| P1 global never consolidates | B5 | consolidate dual-root orchestration workspace + global |
| P1 silent LLM fail | B4/F2 | consolidate failed reasons + health consolidate status counters |
| P1 drain non-durable | C3 | drain-watcher scope finalizer flushes pending idle |
| P1 remember double-confirm | F1 | remember endpoint / writeMemoryNote path (tools + TUI remember) |
| P1 HTTP read scan | E2 | transfer import skips threat; HTTP sanitize (feat scan HTTP reads) |
| P1 hybrid dormant | D3 | embedding hybrid search when provider set; openConfigured FTS when unset |
| P1 hybrid id collision | D3 | hybrid search keys by root:id + MMR |
| P1 double flush | C2 | flush double flush within cooldown appends only once |
| P2 tools single-root | D2 | tools memory_list tags workspace and global; read falls back to global |
| P2 summary budget | F4 | summary regenerate applies workspace/global budgets |
| P2 recall scaffold | D1 | recall buildRecallBlock filters scaffold content-free hits |
| P2 threat thin | A5 | scan filler/ZWSP/modern keys/pem/aws/slack patterns |
| P2 merge marker only | B2 | merged-hashes append/load; consolidate hash ledger re-merge skip |
| P2 merge over cap stuck | B4 | consolidate keeps sources on over-cap / threat / atomic fail |
| P2 note collision | D2 | writeMemoryNote exclusive + retry on collision |
| P2 health single base | F2 | health dual-root walk counts both bases |
| P2 context lie | F3 | context describes notes + session logs → dream → MEMORY.md |
| P2 flush no NO_REPLY | C1 | flush does not write NO_REPLY; isNoReply helper |
| P2 no min_sessions | B4 | consolidate nothing when no sources; minSources via noise filter |
| P3 tmp leak | A3 | storage removes temp file after rename failure |
| prompts thin | B3 | prompts-contract DREAM/FLUSH/DELTA/SUMMARY clauses |

**Open P0/P1:** none.

## Wave G commits

| SHA | Message |
|-----|---------|
| `c63482aa8b` | `test(memory): end-to-end journey without planted candidates` |
| tip after journey | `docs(memory): sync architecture with FULL remediation` (architecture + plan + this status) |

## Suite count

- Files: 28 under `packages/core/test/memory/`
- Tests: **181 pass**, 0 fail
- Journey: 1 pass, 22 expects
