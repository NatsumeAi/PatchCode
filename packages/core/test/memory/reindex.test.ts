import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots } from "../../src/memory/storage"
import { openMemoryIndex, chunkMarkdown, chunkHash, reindexFile } from "../../src/memory/reindex"
import { writeTextAtomic } from "../../src/memory/storage"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Memory index", () => {
  test("chunkMarkdown splits on headers", () => {
    const chunks = chunkMarkdown("## A\none\n\n## B\ntwo three four five", 20)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]!.text).toContain("## A")
    expect(chunks.some((chunk) => chunk.text.includes("## B"))).toBe(true)
  })

  test("chunkMarkdown continuation chunks carry header context", () => {
    const long = "## Decisions\n" + "paragraph one\n\n" + "paragraph two with plenty of words to exceed the limit here"
    const chunks = chunkMarkdown(long, 40)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.text.includes("Decisions"))).toBe(true)
  })

  test("chunkHash is stable hex", () => {
    expect(chunkHash("same")).toBe(chunkHash("same"))
    expect(chunkHash("same")).not.toBe(chunkHash("other"))
    expect(chunkHash("same")).toMatch(/^[a-f0-9]{64}$/)
  })

  it.effect("openMemoryIndex creates index.sqlite and inserts a chunk", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const index = yield* openMemoryIndex(roots)
          yield* index.insert({
            path: "MEMORY.md",
            source: "global",
            text: "remember to verify",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
          })
          const hits = yield* index.search("verify", 10)
          expect(hits.length).toBeGreaterThan(0)
          expect(hits[0]!.path).toBe("MEMORY.md")
          yield* index.close()
        }),
      ),
    ),
  )

  it.effect("reindexFile inserts chunks and dedups on re-run", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const index = yield* openMemoryIndex(roots)
          const file = path.join(roots.globalDir, "MEMORY.md")
          yield* writeTextAtomic(fs, file, "## Decisions\nremember to verify everything")
          const mtime = Date.now()
          yield* reindexFile(index, file, "global", "## Decisions\nremember to verify everything", mtime)
          yield* reindexFile(index, file, "global", "## Decisions\nremember to verify everything", mtime)
          const hits = yield* index.search("verify", 10)
          expect(hits.length).toBeGreaterThan(0)
          const chunks = yield* index.listChunks()
          expect(chunks.length).toBe(1)
          yield* index.close()
        }),
      ),
    ),
  )

  it.effect("incrementAccess bumps the access count", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const index = yield* openMemoryIndex(roots)
          yield* index.insert({
            path: "MEMORY.md",
            source: "global",
            text: "unique token for access test",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
          })
          const hits = yield* index.search("token", 10)
          expect(hits.length).toBe(1)
          yield* index.incrementAccess([hits[0]!.id])
          const chunks = yield* index.listChunks()
          expect(chunks[0]!.accessCount).toBe(1)
          yield* index.close()
        }),
      ),
    ),
  )
})
