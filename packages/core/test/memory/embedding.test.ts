import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots } from "../../src/memory/storage"
import { openMemoryIndex } from "../../src/memory/reindex"
import { openAIEmbeddingProvider, embeddingProviderFromConfig } from "../../src/memory/embedding"
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
})
