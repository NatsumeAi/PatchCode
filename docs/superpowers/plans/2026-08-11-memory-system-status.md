# Memory system status (2026-08-11)

Whole-system gate (not “module tests only”). Tip after system quality pass.

## Suite

```bash
cd packages/core && bun test test/memory/
```

Expect: **292+ pass / 0 fail** (36 files; grew 217 → 292 as gaps 1–6 landed).

## Product paths

| Path | Status |
|------|--------|
| note → consolidate → summary → inject | journey.e2e |
| dual-root export → import | transfer tests |
| /remember HTTP (loopback, no password) | allowed for local TUI |
| /remember HTTP (non-loopback, no password) | **rejected** unless `OPENCODE_MEMORY_HTTP_OPEN=1` or server password set |
| hybrid search | env `OPENCODE_MEMORY_EMBEDDING_*`; health shows hybridEnabled + vectorCoverage + actionHint |
| soft inject / secrets in topics | scan soft_policy + sanitizeTopic natural-language secrets |
| flush cosine near-dup | when embedding env set, `flushSession` embeds candidate+prior and applies cosine ≥0.92 |
| TUI import force | `i` → path → mode select (skip newer / force overwrite); SDK sends `force` in body |
| layered dreaming | light/deep/REM phases advance on stamps; REM writes candidates; recovery when MEMORY.md absent/unhealthy |
| delegation observation | child complete → `extensions/ad_hoc/candidates/deleg-*.md`; consolidate merges candidates into MEMORY.md |
| pre-compress insights | compaction summarize request carries `## Memory insights to preserve` section |
| citations mode | `OPENCODE_MEMORY_CITATIONS=off` → empty recall block; `on`/`auto` keep path citations |
| history import | JSONL / messages-json → `sessions/*.md` (POST /experimental/memory/import-history) |

## Config (operators)

| Env | Purpose |
|-----|---------|
| `OPENCODE_SERVER_PASSWORD` | Basic auth for all experimental APIs |
| `OPENCODE_MEMORY_HTTP_OPEN=1` | Allow unauthenticated memory **writes** from non-loopback (dangerous) |
| `OPENCODE_MEMORY_EMBEDDING_MODEL` | Enable hybrid ranking **and** flush cosine near-dup (posts text to apiBase) |
| `OPENCODE_MEMORY_EMBEDDING_API_BASE` | OpenAI-compatible embed base |
| `OPENCODE_MEMORY_EMBEDDING_API_KEY` | Embed API key |
| `OPENCODE_MEMORY_EMBEDDING_DIMENSIONS` | Vector size (default 1024) |
| `OPENCODE_MEMORY_RECALL_MAX_AGE_DAYS` | Recall TTL for session hits (default 30) |
| `OPENCODE_MEMORY_RECALL_MIN_SCORE` | Recall min decayed score (default 0.15) |
| `OPENCODE_MEMORY_DREAM_LIGHT_HOURS` | Light dream interval (default 6) |
| `OPENCODE_MEMORY_DREAM_DEEP_HOURS` | Deep dream interval (default 24) |
| `OPENCODE_MEMORY_DREAM_REM_HOURS` | REM dream interval (default 168) |
| `OPENCODE_MEMORY_DREAM_DEEP_MIN_ACCESS` | Deep phase minimum access count (default 3) |
| `OPENCODE_MEMORY_DREAM_RECOVERY_HEALTH` | Health threshold triggering recovery dream (default 0.35) |
| `OPENCODE_MEMORY_CITATIONS` | Recall block citations: `auto` \| `on` \| `off` |
| `OPENCODE_MEMORY_PRECOMPRESS` | Inject pre-compress insights into compaction summary (default 1) |
| `OPENCODE_MEMORY_DELEGATION` | Write delegation observations as candidates (default 1) |

## Health fields (TUI + HTTP)

- `lastConsolidateStatus` / `lastConsolidateReason` / `actionHint`
- `hybridEnabled`, `hybridModel`, `vectorCoverage`
- flush counters (persisted across restart)
- `dreamLastLight` / `dreamLastDeep` / `dreamLastRem`, `dreamNextHint`
- `recallMaxAgeDays`, `recallMinScore`, `citationsMode`

## Security decisions implemented

1. **Unauthed memory mutations**: only loopback (or no peer) without server password; set password for remote.
2. **Soft inject**: patterns for “always prioritize repo/owner” and “you must / from now on you”.
3. **Secrets in session topics**: natural-language password/token disclosure dropped from metadata logs.

## Residual system work

- experimental HTTP suite harness 502 (environment-wide, not memory-only) — unit guards cover mutation policy; full e2e needs a healthy experimental instance
