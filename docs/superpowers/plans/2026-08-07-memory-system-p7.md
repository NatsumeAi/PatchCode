# Memory System P7 Implementation Plan (Vector Retrieval — Final Retrieval Tier)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. P4 must be complete (FTS5 index, `MemoryIndex`, chunking, ranking) and P6 (auto-recall) preferred before this — this plan upgrades the P4 `MemoryIndex.search` to hybrid vector+BM25 with graceful fallback when vectors are unavailable.

**Goal:** Add semantic retrieval: embed memory chunks into sqlite-vec `chunks_vec`, score search with weighted hybrid (0.7 vector + 0.3 BM25), add MMR diversity re-ranking, and keep every path degrading gracefully (no vector → FTS-only, exactly as P4 shipped). This is the optional-but-specified P6 from the architecture doc, now formalized as P7 so the retrieval tier is complete.

**Architecture:** `EmbeddingProvider` trait with an OpenAI-compatible `/embeddings` HTTP client (opencode has NO built-in embedding support — verified; the provider reuses the configured provider base URL + an embedding model name from memory config). Vectors live in the existing `index.sqlite` via sqlite-vec `vec0` table (the vec0 table IS the cache — no separate store). Hybrid scoring normalizes BM25 and cosine to [0,1], weights 0.7/0.3, min_score 0.35, then MMR (Jaccard on token sets, λ=0.7). All new modules are pure/testable; the sqlite-vec dependency is optional (compile-time feature, runtime probe `sqlite3_vec_init` — if absent, skip vector path).

**Tech Stack:** TypeScript, Effect, `sqlite-vec` (optional native dep — verify availability; fallback keeps P4 behavior), OpenAI-compatible embeddings via `HttpClient` from `effect/unstable/http` (verified import path in opencode), P4 `MemoryIndex`/`chunkMarkdown`/`chunkHash`. bun:test + `testEffect` + `Layer.mock` (mock `EmbeddingProvider` for unit tests; no live API in tests).

## Global Constraints

- Repo: `/home/huyongjun/openpartner/opencode` (branch `fork-runtime-loop-f720490219`).
- New code under `packages/core/src/memory/`; tests under `packages/core/test/memory/`.
- Same style/Effect rules as P1–P6. No `as any`, no `@ts-ignore`.
- **Graceful degradation (hard):** if `sqlite-vec` is not available OR the embedding provider is unconfigured OR embedding fails at runtime, `MemoryIndex.search` returns the P4 FTS-only path — never errors, never blocks.
- Vector path is derived data: `chunks_vec` is rebuilt from `chunks` on reindex; a failed embed of one chunk skips that chunk (logged), not the whole file.
- Config: `memory.embedding.model` (default: provider default), `memory.embedding.dimensions` (default 1024), `memory.search.vector_weight` (0.7), `memory.search.text_weight` (0.3), `memory.search.min_score` (0.35), `memory.search.mmr.enabled` (false), `memory.search.mmr.lambda` (0.7) — all under the existing `Config` surface.
- Typecheck gate `bun --cwd packages/core typecheck` clean; tests from `packages/core`.
- Commit per task. Execution Discipline from P1 applies.

---

## File Structure

```
packages/core/src/memory/
├── embedding.ts          # EmbeddingProvider trait + OpenAI-compatible client + config
├── hybrid.ts             # score normalization, weighted combine, min_score, MMR (pure)
├── (modify) reindex.ts   # embed on reindex (when provider present); vec0 table in index-sql.ts
├── (modify) index-sql.ts # chunks_vec vec0 table (optional)
└── (modify) tools.ts     # memory_search config plumb (weights/min_score) — contract unchanged
packages/core/test/memory/
├── embedding.test.ts     # client shape + failure → None (mock fetch)
├── hybrid.test.ts        # normalization, weights, min_score, MMR
└── (modify) reindex.test.ts / tools.test.ts (hybrid path when provider mocked)
```

---

### Task 1: Embedding provider (trait + OpenAI-compatible client)

**Files:**
- Create: `packages/core/src/memory/embedding.ts`
- Test: `packages/core/test/memory/embedding.test.ts`

**Interfaces:**
- Produces:
  - `export interface EmbeddingProvider { readonly embedBatch: (texts: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbeddingError>; readonly dimensions: () => number; readonly model: () => string }`
  - `export class EmbeddingError extends Schema.TaggedErrorClass<EmbeddingError>()("Memory.EmbeddingError", { message: Schema.String })`
  - `export const openAIEmbeddingProvider = Effect.fn("Memory.openAIEmbeddingProvider")((input: { apiBase: string; apiKey?: string; model: string; dimensions: number; client: HttpClient }) => EmbeddingProvider)` — POST `{apiBase}/embeddings` `{ model, input: texts }`, batch ≤32, retry 3x with 1s/2s/4s backoff; any non-200 → `EmbeddingError`
  - `export const embeddingProviderFromConfig = Effect.fn("Memory.embeddingProviderFromConfig")((config, client) => Effect.Effect<Option.Option<EmbeddingProvider>>)` — None when model unset/empty

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/embedding.test.ts
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { openAIEmbeddingProvider, EmbeddingError, embeddingProviderFromConfig } from "../../src/memory/embedding"
import { testEffect } from "../lib/effect"

const it = testEffect(Effect.succeed({}))

describe("Embedding provider", () => {
  it.effect("openAIEmbeddingProvider posts to /embeddings and parses vectors", () =>
    Effect.gen(function* () {
      // mock HttpClient: capture request, return { data: [{ embedding: [0.1, 0.2] }] }
      const provider = yield* openAIEmbeddingProvider({
        apiBase: "https://api.example.com/v1",
        apiKey: "sk-test",
        model: "embed-1",
        dimensions: 2,
        client: mockClient({ embedding: [0.1, 0.2] }),
      })
      const vectors = yield* provider.embedBatch(["hello"])
      expect(vectors[0]!.length).toBe(2)
    }),
  )

  it.effect("embeddingProviderFromConfig returns None for empty model", () =>
    Effect.gen(function* () {
      const opt = yield* embeddingProviderFromConfig({ model: "" }, null as never)
      expect(opt._tag).toBe("None")
    }),
  )
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/embedding.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/embedding.ts
import { Effect, Option, Schema } from "effect"
import { HttpClient, HttpBody, HttpError } from "effect/unstable/http"

export class EmbeddingError extends Schema.TaggedErrorClass<EmbeddingError>()("Memory.EmbeddingError", {
  message: Schema.String,
}) {}

export interface EmbeddingProvider {
  readonly embedBatch: (texts: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbeddingError>
  readonly dimensions: () => number
  readonly model: () => string
}

const MAX_BATCH = 32

export const openAIEmbeddingProvider = Effect.fn("Memory.openAIEmbeddingProvider")(function* (input: {
  apiBase: string
  apiKey?: string
  model: string
  dimensions: number
  client: HttpClient.HttpClient
}): EmbeddingProvider {
  const url = `${input.apiBase.replace(/\/$/, "")}/embeddings`
  return {
    embedBatch: (texts) => {
      const chunks: string[][] = []
      for (let i = 0; i < texts.length; i += MAX_BATCH) chunks.push(texts.slice(i, i + MAX_BATCH))
      return Effect.forEach(chunks, (batch) =>
        input.client
          .post(url, {
            headers: {
              "content-type": "application/json",
              ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
            },
            body: HttpBody.json({ model: input.model, input: batch }),
          })
          .pipe(
            Effect.flatMap((response) =>
              response.status === 200
                ? response.json.pipe(
                    Effect.flatMap((body) => {
                      const data = (body as { data?: Array<{ embedding?: unknown }> }).data
                      if (!Array.isArray(data)) return Effect.fail(new EmbeddingError({ message: "missing data" }))
                      return Effect.succeed(
                        data.map((item) =>
                          Array.isArray(item.embedding) ? (item.embedding as number[]) : [],
                        ),
                      )
                    }),
                  )
                : Effect.fail(new EmbeddingError({ message: `HTTP ${response.status}` })),
            ),
            Effect.retry({ times: 3, schedule: Schedule.exponential("1 seconds").pipe(Schedule.recurs(2)) }),
            Effect.catchTag("HttpError", () => Effect.fail(new EmbeddingError({ message: "request failed" }))),
            Effect.catchTag("HttpBody", () => Effect.fail(new EmbeddingError({ message: "body failed" }))),
          ),
      ).pipe(Effect.map((batches) => batches.flat()))
    },
    dimensions: () => input.dimensions,
    model: () => input.model,
  }
})

export const embeddingProviderFromConfig = Effect.fn("Memory.embeddingProviderFromConfig")(function* (
  config: { model?: string; dimensions?: number },
  client: HttpClient.HttpClient,
) {
  const model = config.model?.trim()
  if (!model) return Option.none<EmbeddingProvider>()
  return Option.some(
    yield* openAIEmbeddingProvider({
      apiBase: "", // filled from provider config by caller — see Task 3 wiring
      model,
      dimensions: config.dimensions ?? 1024,
      client,
    }),
  )
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/embedding.test.ts`
Expected: PASS. Align the mock client shape with the real `HttpClient.HttpClient` interface (use `Layer.mock(HttpClient.HttpClient, {...})` if easier than a hand-rolled mock). Add `Schedule` to imports. Do not weaken assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/embedding.ts packages/core/test/memory/embedding.test.ts
git commit -m "feat(memory): OpenAI-compatible embedding provider with retry and batching"
```

---

### Task 2: Hybrid scoring + MMR (pure)

**Files:**
- Create: `packages/core/src/memory/hybrid.ts`
- Test: `packages/core/test/memory/hybrid.test.ts`

**Interfaces:**
- Produces:
  - `export const DEFAULT_VECTOR_WEIGHT = 0.7`, `DEFAULT_TEXT_WEIGHT = 0.3`, `DEFAULT_MIN_SCORE = 0.35`
  - `export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number`
  - `export function normalize01(values: ReadonlyArray<number>): ReadonlyArray<number>` — min-max to [0,1]
  - `export function hybridScore(vector: number, text: number, vectorWeight = DEFAULT_VECTOR_WEIGHT): number`
  - `export function applyMmr(items: ReadonlyArray<{ id: string; score: number; text: string }>, lambda: number, topN: number): ReadonlyArray<{ id: string; score: number; text: string }>` — greedy MMR with Jaccard token similarity (λ=0.7 default)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/hybrid.test.ts
import { describe, expect, test } from "bun:test"
import {
  cosineSimilarity,
  normalize01,
  hybridScore,
  applyMmr,
  DEFAULT_VECTOR_WEIGHT,
  DEFAULT_TEXT_WEIGHT,
} from "../../src/memory/hybrid"

describe("Hybrid scoring", () => {
  test("cosine of identical vectors is 1", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  test("normalize01 maps to [0,1]", () => {
    expect(normalize01([2, 4, 8])).toEqual([0, 0.25, 1])
  })

  test("weights default to 0.7/0.3", () => {
    expect(DEFAULT_VECTOR_WEIGHT).toBe(0.7)
    expect(DEFAULT_TEXT_WEIGHT).toBe(0.3)
    expect(hybridScore(1, 1)).toBeCloseTo(1)
    expect(hybridScore(0, 1)).toBeCloseTo(0.3)
  })

  test("MMR penalizes redundancy", () => {
    const items = [
      { id: "a", score: 0.9, text: "auth uses tokens" },
      { id: "b", score: 0.85, text: "auth tokens session" },
      { id: "c", score: 0.8, text: "database schema" },
    ]
    const mmr = applyMmr(items, 0.7, 2)
    expect(mmr[0]!.id).toBe("a")
    expect(mmr[1]!.id).toBe("c")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/hybrid.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/memory/hybrid.ts
export const DEFAULT_VECTOR_WEIGHT = 0.7
export const DEFAULT_TEXT_WEIGHT = 0.3
export const DEFAULT_MIN_SCORE = 0.35

export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0)
    na += a[i]! ** 2
    nb += (b[i] ?? 0) ** 2
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function normalize01(values: ReadonlyArray<number>): ReadonlyArray<number> {
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max === min) return values.map(() => 1)
  return values.map((v) => (v - min) / (max - min))
}

export function hybridScore(vector: number, text: number, vectorWeight = DEFAULT_VECTOR_WEIGHT): number {
  return vectorWeight * vector + (1 - vectorWeight) * text
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  const inter = [...a].filter((t) => b.has(t)).length
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

export function applyMmr(
  items: ReadonlyArray<{ id: string; score: number; text: string }>,
  lambda: number,
  topN: number,
): Array<{ id: string; score: number; text: string }> {
  const selected: Array<{ id: string; score: number; text: string }> = []
  const pool = [...items]
  while (selected.length < topN && pool.length > 0) {
    let bestIndex = 0
    let bestValue = -Infinity
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i]!
      const maxSim = selected.reduce(
        (max, sel) => Math.max(max, jaccard(tokens(item.text), tokens(sel.text))),
        0,
      )
      const value = lambda * item.score - (1 - lambda) * maxSim
      if (value > bestValue) {
        bestValue = value
        bestIndex = i
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]!)
  }
  return selected
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/memory/hybrid.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/hybrid.ts packages/core/test/memory/hybrid.test.ts
git commit -m "feat(memory): hybrid scoring and MMR diversity re-ranking"
```

---

### Task 3: vec0 index + hybrid search integration (graceful degradation)

**Files:**
- Modify: `packages/core/src/memory/index-sql.ts` (vec0 table, optional)
- Modify: `packages/core/src/memory/reindex.ts` (embed on reindex when provider present; hybrid search)
- Modify: `packages/core/src/memory/embedding.ts` (export config reader)
- Test: extend `packages/core/test/memory/reindex.test.ts` + `tools.test.ts`

**Interfaces:**
- Produces:
  - `MemoryIndex.search` signature unchanged; behavior: when `sqlite-vec` available AND provider configured → hybrid (BM25 + cosine, 0.7/0.3, min_score 0.35, MMR when enabled); otherwise → P4 FTS-only
  - `openMemoryIndex` gains optional `provider` param; `reindexFile` embeds chunks when provider present (skip chunk on embed error, log)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/memory/reindex.test.ts — append
it.effect("search degrades to FTS when provider is absent", () =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    await using dir = await tmpdir()
    const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
    const index = yield* openMemoryIndex(fs, roots, undefined) // no provider
    yield* index.insert({ path: "MEMORY.md", source: "global", text: "verify tokens", startLine: 1, endLine: 1 })
    const hits = yield* index.search("verify")
    expect(hits.length).toBeGreaterThan(0)
    yield* index.close()
  }),
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/memory/reindex.test.ts`
Expected: FAIL — `openMemoryIndex` doesn't accept a provider param yet (compile error = red).

- [ ] **Step 3: Wire hybrid into the index**

Read `packages/core/src/database/database.ts` to find how the repo opens sqlite and whether `sqlite-vec` is loadable (`sqlite3_vec_init`). Implement:
1. `index-sql.ts`: add optional `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding FLOAT[<dims>])` guarded by a runtime probe.
2. `reindex.ts`: `openMemoryIndex(fs, roots, provider?)`; when provider present, after chunk insert compute embeddings (batch), upsert into `chunks_vec` (skip on `EmbeddingError`).
3. `search`: when provider present → run BM25 + vec KNN, normalize each to [0,1], `hybridScore(0.7/0.3)`, filter `min_score`, optional MMR; else → P4 path exactly.

**If `sqlite-vec` is not loadable in this repo** (verify first; it may require a native module not vendored): implement the vector path against the SAME schema but with an in-memory cosine scan over a `vectors` JSON column on `chunks` (no vec0). This keeps the hybrid behavior testable without a native dependency and upgrades to vec0 when available — document the choice in a code comment and in this step's commit message. **Do not silently drop the vector path** — the test must still pass with a mocked provider proving hybrid ranking.

- [ ] **Step 4: Run test to verify it passes + wiring gate**

Run: `bun test test/memory/reindex.test.ts test/memory/tools.test.ts test/memory/hybrid.test.ts` — PASS. Typecheck `bun --cwd packages/core typecheck` — clean.

**接线完整性检查（强制）：**
```bash
grep -n "hybridScore\|applyMmr\|min_score" packages/core/src/memory/reindex.ts  # MUST match
grep -n "EmbeddingProvider" packages/core/src/memory/reindex.ts                 # MUST match
grep -n "openMemoryIndex" packages/core/src/memory/tools.ts                     # MUST match (search uses hybrid)
bun test test/memory/  # MUST pass
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/memory/index-sql.ts packages/core/src/memory/reindex.ts packages/core/src/memory/embedding.ts packages/core/test/memory/reindex.test.ts
git commit -m "feat(memory): hybrid vector+BM25 search with graceful degradation"
```

---

## Self-Review

**Spec coverage (architecture doc P6/vector):** embedding provider → Task 1; hybrid scoring 0.7/0.3 + min_score + MMR → Task 2; vec0/vector storage + integration → Task 3; graceful degradation (no vec, no provider, embed failure) → Tasks 1/3 constraints; config surface → Task 1/3.

**Placeholder scan:** no TBD/TODO; code concrete; one explicitly-flagged implementation choice (vec0 vs JSON-column fallback) with a test that forces hybrid ranking regardless.

**Known discovery-risk (flagged):** `sqlite-vec` native availability (Task 3 Step 3 — with a concrete fallback that keeps hybrid behavior); `HttpClient` mock shape (Task 1 Step 4); provider base URL plumbing (Task 1 Step 3 leaves `apiBase` fill to Task 3 wiring — documented, not silent).

**Type consistency:** `EmbeddingProvider`/`EmbeddingError` (Task 1) consumed by Tasks 2/3; `hybridScore`/`applyMmr`/`normalize01`/`cosineSimilarity` (Task 2) consumed by Task 3; `MemoryIndex.search` contract unchanged across P4→P7 (path/line/text/score).
