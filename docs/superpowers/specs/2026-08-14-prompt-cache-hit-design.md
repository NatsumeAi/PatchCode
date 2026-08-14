# Prompt Cache Hit Rate — Design

**Date:** 2026-08-14
**Status:** draft for plan
**Goal:** Raise *steady-state input cache hit* toward 99.85% without silent regression.

## 1. Metric (locked)

Steady-state input hit, **not** session-lifetime including first write:

```
hit = cache_read / (cache_read + uncached_input)
```

Exclude from the target:

- first request of an epoch (cache write / cold prefix)
- first request after compaction rewrite
- model / provider switch

99.85% means: after warmup, only the newest ~0.15% of input tokens are uncached (≈150 tokens on a 100k prefix). A single large tool result can dip one request; the **next** request must absorb that result into the prefix.

CI **must not** assert `hit === 0.9985`. That number depends on prefix length and the live provider. CI asserts the *structural* conditions that make 99.85% possible. Live usage on the allowlisted models is the scoreboard.

## 2. Why hit rate can drop invisibly

Cache is a performance property. Session-runner and unit tests stay green while prefix bytes drift. Existing coverage only checks toy `cache_control` placement and identical-second-call cassettes — not a growing tool loop.

Guarantee = **prefix contract + overlap must not fall + live allowlist usage**, not “all tests passed.”

## 3. Two test layers (both required)

### 3.1 CI — no network — prefix contract

Compile `LLMRequest` through `LLMClient.prepare` (same path as production `compile` → `applyCachePolicy` → wire body).

On a growing tool-loop fixture (same user, append assistant + tool_result):

1. `hash(tools_n) === hash(tools_{n+1})`
2. `hash(system_n) === hash(system_{n+1})`
3. `body_{n+1}` has `body_n` as a strict prefix (only new trailing blocks)
4. `overlap = common_prefix_tokens / tokens(body_{n+1})` is computed and snapshotted
5. After a behavior change, overlap on the **same fixture** must not decrease

Negative tests must fail if someone re-introduces: `Date.now()` in system, shuffled tool order, verifier/timer in the frozen system prefix.

### 3.2 Live — allowlisted models only

**Hard allowlist. No other model, host, or direct vendor API.**

| Slot | Provider ID | Model ID | Endpoint |
|---|---|---|---|
| Primary (required) | `opencode-go` | `deepseek-v4-flash` | `https://opencode.ai/zen/go/v1/chat/completions` |
| Secondary (allowed) | `opencode` (Zen) | `deepseek-v4-flash` or `deepseek-v4-flash-free` | `https://opencode.ai/zen/v1/chat/completions` |

Checked-in live tests construct **only** those three pairs. Expanding Zen to other catalog ids requires a deliberate allowlist edit — not an env that points at Anthropic/OpenAI/Gemini hosts.

Forbidden for this workstream (live or new recordings):

- Anthropic / OpenAI / Gemini / Bedrock / OpenRouter direct
- official `api.deepseek.com`
- user `opencode.json` third-party providers (`tjg`, `token-plan`, etc.)
- any model not served as `opencode-go/*` or `opencode/*` through the two hosts above

Go and Zen DeepSeek are **OpenAI-compatible implicit prefix cache**. They report hits as `usage.prompt_tokens_details.cached_tokens` (mapped to `cacheReadInputTokens`). They ignore Anthropic `cache_control`. Live tests therefore prove **byte-stable prefix → real `cached_tokens`**, which is the production path for these models.

Anthropic/OpenAI-specific wire markers still get **offline** `prepare()` assertions. They are never live-called in this plan.

Auth: existing OpenCode credentials via env (`OPENCODE_API_KEY` or `OPENCODE_GO_API_KEY` / `OPENCODE_ZEN_API_KEY`). Never commit keys. Live tests skip unless `LIVE_CACHE=1` (or `RECORD=true`) **and** a key is present.

## 4. Change order (anti-silent-drop)

1. Land measurement + characterization snapshots of **current** bodies (allowed to look bad).
2. Land overlap / hash / negative tests against that baseline.
3. Probe live Go DeepSeek: confirm `cached_tokens` is populated on an identical second call.
4. Only then change assembly (tool freeze, move dynamic system, breakpoint policy).
5. Same fixture: new overlap ≥ old overlap, or revert.
6. Live Go (required) + live Zen (allowed) re-run; steady-state hit must not fall vs the pre-change live baseline recorded in the same session.

## 5. Product changes in scope (after measurement)

Priority is what Go/Zen implicit cache actually sees:

1. **Tool definitions session-stable** — sort by name; freeze task-catalog text for the epoch.
2. **Dynamic text out of system prefix** — verifier / timer become trailing messages, not `system[]`.
3. **Hit-rate telemetry** — persist and log steady-state hit from existing token fields.
4. **Cache policy** — last-message / last-tool-result breakpoint + 1h TTL for protocols that honor inline hints (offline tests only; does not affect DeepSeek wire).

Out of scope: enabling production circuit breaker; changing drain; compaction algorithm; pushing remotes.

## 6. Risks

- If Go/Zen omit `cached_tokens`, live hit cannot be scored; CI prefix contract remains the gate; the probe task records that fact and does not fake 99.85%.
- First live request is always a miss; assertions start at request 2.
- A 5k tool result will dip one request; the following request must show that 5k inside `cache_read`.
