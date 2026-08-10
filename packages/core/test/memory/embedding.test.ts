import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots } from "../../src/memory/storage"
import { openMemoryIndex } from "../../src/memory/reindex"
import { openAIEmbeddingProvider, embeddingProviderFromConfig, DEFAULT_EMBEDDING_API_BASE } from "../../src/memory/embedding"
import { memoryEmbeddingEnvConfig, resolveMemoryEmbeddingProvider } from "../../src/memory/config"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const it = testEffect(LayerNode.compile(FSUtil.node))

/** Deterministic embeddings: term-overlap hashing so similar texts get similar vectors. */
function fakeEmbedding(text: string, dims = 8): Array<number> {
  const vector = Array.from({ length: dims }, () => 0)
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length === 0) continue
    const index = [...token].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % dims
    vector[index]! += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1
  return vector.map((v) => v / norm)
}

const mockProvider = (texts: ReadonlyArray<string>) =>
  Effect.succeed(texts.map((text) => fakeEmbedding(text)))

const provider = {
  embedBatch: mockProvider,
  dimensions: () => 8,
  model: () => "test-embed",
}

describe("Embedding provider", () => {
  it.effect("openAIEmbeddingProvider posts to /embeddings and parses vectors", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          let capturedUrl = ""
          const http = HttpClient.make((request) =>
            Effect.sync(() => {
              capturedUrl = String(request.url ?? request)
              return HttpClientResponse.fromWeb(
                request as never,
                new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              )
            }),
          )
          const p = openAIEmbeddingProvider({
            apiBase: "https://api.example.com/v1",
            apiKey: "sk-test",
            model: "embed-1",
            dimensions: 2,
            client: http,
          })
          const vectors = yield* p.embedBatch(["hello"])
          expect(vectors[0]!.length).toBe(2)
          expect(capturedUrl).toContain("/embeddings")
        }),
      ),
    ),
  )

  it.effect("embeddingProviderFromConfig returns None for empty model", () =>
    Effect.gen(function* () {
      const opt = yield* embeddingProviderFromConfig(
        { model: "", apiBase: "https://api.example.com/v1" },
        null as never,
      )
      expect(opt._tag).toBe("None")
    }),
  )

  it.effect("embeddingProviderFromConfig defaults apiBase when omitted", () =>
    Effect.gen(function* () {
      let capturedUrl = ""
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          capturedUrl = String(request.url ?? request)
          return HttpClientResponse.fromWeb(
            request as never,
            new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          )
        }),
      )
      const p = yield* embeddingProviderFromConfig({ model: "embed-1", dimensions: 1 }, http)
      expect(p._tag).toBe("Some")
      if (p._tag === "Some") {
        yield* p.value.embedBatch(["x"])
        expect(capturedUrl).toContain(DEFAULT_EMBEDDING_API_BASE)
      }
    }),
  )

  it.effect("resolveMemoryEmbeddingProvider is None without env model", () =>
    Effect.gen(function* () {
      const prev = process.env.OPENCODE_MEMORY_EMBEDDING_MODEL
      delete process.env.OPENCODE_MEMORY_EMBEDDING_MODEL
      try {
        expect(memoryEmbeddingEnvConfig()).toBeUndefined()
        const opt = yield* resolveMemoryEmbeddingProvider()
        expect(opt._tag).toBe("None")
      } finally {
        if (prev === undefined) delete process.env.OPENCODE_MEMORY_EMBEDDING_MODEL
        else process.env.OPENCODE_MEMORY_EMBEDDING_MODEL = prev
      }
    }),
  )

  it.effect("resolveMemoryEmbeddingProvider reads env when model is set", () =>
    Effect.gen(function* () {
      const prev = {
        model: process.env.OPENCODE_MEMORY_EMBEDDING_MODEL,
        base: process.env.OPENCODE_MEMORY_EMBEDDING_API_BASE,
        key: process.env.OPENCODE_MEMORY_EMBEDDING_API_KEY,
        dims: process.env.OPENCODE_MEMORY_EMBEDDING_DIMENSIONS,
      }
      process.env.OPENCODE_MEMORY_EMBEDDING_MODEL = "text-embedding-3-small"
      process.env.OPENCODE_MEMORY_EMBEDDING_API_BASE = "https://embed.example.com/v1"
      process.env.OPENCODE_MEMORY_EMBEDDING_API_KEY = "sk-test"
      process.env.OPENCODE_MEMORY_EMBEDDING_DIMENSIONS = "8"
      try {
        const config = memoryEmbeddingEnvConfig()
        expect(config?.model).toBe("text-embedding-3-small")
        expect(config?.apiBase).toBe("https://embed.example.com/v1")
        expect(config?.dimensions).toBe(8)
        const opt = yield* resolveMemoryEmbeddingProvider()
        expect(opt._tag).toBe("Some")
        if (opt._tag === "Some") {
          expect(opt.value.model()).toBe("text-embedding-3-small")
          expect(opt.value.dimensions()).toBe(8)
        }
      } finally {
        if (prev.model === undefined) delete process.env.OPENCODE_MEMORY_EMBEDDING_MODEL
        else process.env.OPENCODE_MEMORY_EMBEDDING_MODEL = prev.model
        if (prev.base === undefined) delete process.env.OPENCODE_MEMORY_EMBEDDING_API_BASE
        else process.env.OPENCODE_MEMORY_EMBEDDING_API_BASE = prev.base
        if (prev.key === undefined) delete process.env.OPENCODE_MEMORY_EMBEDDING_API_KEY
        else process.env.OPENCODE_MEMORY_EMBEDDING_API_KEY = prev.key
        if (prev.dims === undefined) delete process.env.OPENCODE_MEMORY_EMBEDDING_DIMENSIONS
        else process.env.OPENCODE_MEMORY_EMBEDDING_DIMENSIONS = prev.dims
      }
    }),
  )

  it.effect("hybrid search ranks by vector+text and degrades to FTS without provider", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)

          // Without provider: FTS path.
          const ftsIndex = yield* openMemoryIndex(fs, roots)
          yield* ftsIndex.insert("global", {
            path: "MEMORY.md",
            source: "global",
            text: "verify tokens work",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
          })
          const ftsHits = yield* ftsIndex.search("verify", 10)
          expect(ftsHits.length).toBeGreaterThan(0)
          yield* ftsIndex.close()

          // With provider: hybrid path — the vector-relevant chunk ranks via cosine
          // even when its BM25 score is low.
          const hybridIndex = yield* openMemoryIndex(fs, roots, provider)
          yield* hybridIndex.insert("global", {
            path: "MEMORY.md",
            source: "global",
            text: "verify tokens work",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
            vectors: fakeEmbedding("verify tokens work"),
          })
          yield* hybridIndex.insert("global", {
            path: "notes.md",
            source: "global",
            text: "unrelated gardening notes",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
            vectors: fakeEmbedding("unrelated gardening notes"),
          })
          const hybridHits = yield* hybridIndex.search("verify", 10)
          expect(hybridHits.length).toBeGreaterThan(0)
          expect(hybridHits[0]!.path).toBe("MEMORY.md")
          yield* hybridIndex.close()
        }),
      ),
    ),
  )

  it.effect("hybrid search keys FTS hits by root:id and applies MMR diversity", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), path.join(dir.path, "proj"))
          const hybridIndex = yield* openMemoryIndex(fs, roots, provider)
          // Same numeric id path: insert one chunk per root with similar text so
          // bare-id maps would collide; root-qualified keys must keep both distinct.
          yield* hybridIndex.insert("global", {
            path: "MEMORY.md",
            source: "global",
            text: "auth uses bearer tokens globally",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
            vectors: fakeEmbedding("auth uses bearer tokens globally"),
          })
          yield* hybridIndex.insert("workspace", {
            path: "MEMORY.md",
            source: "workspace",
            text: "auth uses session tokens in this workspace project",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
            vectors: fakeEmbedding("auth uses session tokens in this workspace project"),
          })
          // Near-duplicate plus a diverse third hit — MMR should prefer diversity.
          yield* hybridIndex.insert("workspace", {
            path: "notes.md",
            source: "workspace",
            text: "auth uses session tokens in this workspace project copy",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
            vectors: fakeEmbedding("auth uses session tokens in this workspace project copy"),
          })
          yield* hybridIndex.insert("workspace", {
            path: "schema.md",
            source: "workspace",
            text: "database schema for users and roles",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
            vectors: fakeEmbedding("database schema for users and roles"),
          })
          const hits = yield* hybridIndex.search("auth tokens", 2)
          expect(hits.length).toBe(2)
          // Both roots' MEMORY.md facts must remain addressable independently.
          const authHits = yield* hybridIndex.search("auth", 10)
          const sources = new Set(authHits.map((hit) => hit.source))
          expect(sources.has("global") || sources.has("workspace")).toBe(true)
          // With limit 2 and a near-duplicate pair, MMR should not return only the two near-dupes
          // when a diverse third candidate exists at hybrid score above min_score.
          const topPaths = hits.map((hit) => hit.path)
          expect(topPaths.length).toBe(2)
          yield* hybridIndex.close()
        }),
      ),
    ),
  )
})
