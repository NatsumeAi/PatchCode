# Memory system status (2026-08-11)

Whole-system gate (not “module tests only”). Tip after system quality pass.

## Suite

```bash
cd packages/core && bun test test/memory/
```

Expect: **209+ pass / 0 fail** (grows with new unit tests).

## Product paths

| Path | Status |
|------|--------|
| note → consolidate → summary → inject | journey.e2e |
| dual-root export → import | transfer tests |
| /remember HTTP (loopback, no password) | allowed for local TUI |
| /remember HTTP (non-loopback, no password) | **rejected** unless `OPENCODE_MEMORY_HTTP_OPEN=1` or server password set |
| hybrid search | env `OPENCODE_MEMORY_EMBEDDING_*`; health shows hybridEnabled + vectorCoverage + actionHint |
| soft inject / secrets in topics | scan soft_policy + sanitizeTopic natural-language secrets |

## Config (operators)

| Env | Purpose |
|-----|---------|
| `OPENCODE_SERVER_PASSWORD` | Basic auth for all experimental APIs |
| `OPENCODE_MEMORY_HTTP_OPEN=1` | Allow unauthenticated memory **writes** from non-loopback (dangerous) |
| `OPENCODE_MEMORY_EMBEDDING_MODEL` | Enable hybrid ranking (posts chunk text to apiBase) |
| `OPENCODE_MEMORY_EMBEDDING_API_BASE` | OpenAI-compatible embed base |
| `OPENCODE_MEMORY_EMBEDDING_API_KEY` | Embed API key |
| `OPENCODE_MEMORY_EMBEDDING_DIMENSIONS` | Vector size (default 1024) |

## Health fields (TUI + HTTP)

- `lastConsolidateStatus` / `lastConsolidateReason` / `actionHint`
- `hybridEnabled`, `hybridModel`, `vectorCoverage`
- flush counters (persisted across restart)

## Security decisions implemented

1. **Unauthed memory mutations**: only loopback (or no peer) without server password; set password for remote.
2. **Soft inject**: patterns for “always prioritize repo/owner” and “you must / from now on you”.
3. **Secrets in session topics**: natural-language password/token disclosure dropped from metadata logs.

## Residual system work (if still open after this commit)

- experimental HTTP suite harness 502 (environment-wide, not memory-only) — unit guards cover mutation policy
- core typecheck non-memory files if any remain after this pass
- optional force-import UX toggle in TUI (messages improved; force flag still API-only)
