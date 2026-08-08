import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots } from "../../src/memory/storage"
import { openMemoryIndex, chunkMarkdown, chunkHash, reindexFile, ensureIndexed } from "../../src/memory/reindex"
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
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const index = yield* openMemoryIndex(fs, roots)
          yield* index.insert("global", {
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
          const index = yield* openMemoryIndex(fs, roots)
          const file = path.join(roots.globalDir, "MEMORY.md")
          yield* writeTextAtomic(fs, file, "## Decisions\nremember to verify everything")
          const mtime = Date.now()
          yield* reindexFile(index, "global", file, "global", "## Decisions\nremember to verify everything", mtime)
          yield* reindexFile(index, "global", file, "global", "## Decisions\nremember to verify everything", mtime)
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
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const index = yield* openMemoryIndex(fs, roots)
          yield* index.insert("global", {
            path: "MEMORY.md",
            source: "global",
            text: "unique token for access test",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
          })
          const hits = yield* index.search("token", 10)
          expect(hits.length).toBe(1)
          yield* index.incrementAccess([{ id: hits[0]!.id, source: "global" }])
          const chunks = yield* index.listChunks()
          expect(chunks[0]!.accessCount).toBe(1)
          yield* index.close()
        }),
      ),
    ),
  )
})

describe("Memory index dual-root", () => {
  it.effect("chunks are not mirrored across roots; search merges both", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), path.join(dir.path, "proj"))
          const index = yield* openMemoryIndex(fs, roots)
          yield* index.insert("global", {
            path: "MEMORY.md",
            source: "global",
            text: "global-only fact about the architecture",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
          })
          yield* index.insert("workspace", {
            path: "TASKS.md",
            source: "workspace",
            text: "workspace-only task list entry",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
          })
          // Workspace index must not contain the global chunk and vice versa.
          const chunks = yield* index.listChunks()
          expect(chunks.filter((chunk) => chunk.path === "MEMORY.md").length).toBe(1)
          expect(chunks.filter((chunk) => chunk.path === "TASKS.md").length).toBe(1)
          // Search across both roots finds each once.
          const globalHits = yield* index.search("architecture", 10)
          expect(globalHits.length).toBe(1)
          expect(globalHits[0]!.path).toBe("MEMORY.md")
          expect(globalHits[0]!.source).toBe("global")
          const taskHits = yield* index.search("task", 10)
          expect(taskHits.length).toBe(1)
          expect(taskHits[0]!.source).toBe("workspace")
          // Deleting from one root leaves the other untouched.
          yield* index.deletePath("workspace", "TASKS.md")
          const remaining = yield* index.listChunks()
          expect(remaining.filter((chunk) => chunk.path === "MEMORY.md").length).toBe(1)
          expect(remaining.filter((chunk) => chunk.path === "TASKS.md").length).toBe(0)
          yield* index.close()
        }),
      ),
    ),
  )
})

describe("Memory index multi-chunk", () => {
  it.effect("chunkIdsForPath attributes ids to their owning root", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), path.join(dir.path, "proj"))
          const index = yield* openMemoryIndex(fs, roots)
          // Same relative path in BOTH roots — ids must be attributed to their own root.
          yield* index.insert("global", {
            path: "MEMORY.md",
            source: "global",
            text: "global copy of MEMORY.md",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
          })
          yield* index.insert("workspace", {
            path: "MEMORY.md",
            source: "workspace",
            text: "workspace copy of MEMORY.md",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
          })
          const hits = yield* index.chunkIdsForPath("MEMORY.md")
          const sources = hits.map((hit) => hit.source).sort()
          expect(sources).toEqual(["global", "workspace"])
          // Per-root AUTOINCREMENT: both roots may assign the same numeric id,
          // which is why attribution by root is required before bumping.
          const workspaceHit = hits.find((hit) => hit.source === "workspace")!
          const globalHit = hits.find((hit) => hit.source === "global")!
          // Bump only the workspace hit; the global chunk's count must stay 0
          // even though the numeric ids may collide.
          yield* index.incrementAccess([{ id: workspaceHit.id, source: "workspace" }])
          const chunks = yield* index.listChunks()
          const workspaceChunk = chunks.find((c) => c.source === "workspace")!
          const globalChunk = chunks.find((c) => c.source === "global")!
          expect(workspaceChunk.accessCount).toBe(1)
          expect(globalChunk.accessCount).toBe(0)
          yield* index.close()
        }),
      ),
    ),
  )

  it.effect("reindexes multi-chunk files and bumps multiple access ids", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const index = yield* openMemoryIndex(fs, roots)
          const file = path.join(roots.globalDir, "MEMORY.md")
          const longPara = (base: string) =>
            Array.from({ length: 60 }, (_, i) => `${base} sentence ${i} with enough words to fill a chunk`).join(" ")
          const content = `## Section one\n${longPara("alpha")}\n\n## Section two\n${longPara("beta")}`
          yield* writeTextAtomic(fs, file, content)
          const mtime = Date.now()
          yield* reindexFile(index, "global", file, "global", content, mtime)
          const chunks = yield* index.listChunks()
          expect(chunks.length).toBeGreaterThanOrEqual(2)
          const hits = yield* index.search("Section", 10)
          expect(hits.length).toBeGreaterThanOrEqual(2)
          // Multi-id access bump must not throw.
          yield* index.incrementAccess(chunks.map((chunk) => ({ id: chunk.id, source: "global" })))
          const after = yield* index.listChunks()
          expect(after.every((chunk) => chunk.accessCount === 1)).toBe(true)
          // Re-reindex preserves access counts (same content).
          yield* reindexFile(index, "global", file, "global", content, mtime + 1)
          const preserved = yield* index.listChunks()
          expect(preserved.length).toBeGreaterThanOrEqual(2)
          expect(preserved.every((chunk) => chunk.accessCount === 1)).toBe(true)
          yield* index.close()
        }),
      ),
    ),
  )

  it.effect("ensureIndexed drops orphan session chunks from the workspace index", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), path.join(dir.path, "proj"))
          const index = yield* openMemoryIndex(fs, roots)
          // Session chunk lives in the WORKSPACE index (per-session capture).
          yield* index.insert("workspace", {
            path: "sessions/ses_abc123.md",
            source: "session",
            text: "stale session chunk whose file was deleted",
            startLine: 1,
            endLine: 1,
            mtimeMs: Date.now(),
          })
          // No matching file exists on disk, so ensureIndexed must orphan-drop it
          // from the workspace index (not attempt a no-op delete on global).
          yield* ensureIndexed(index, fs, roots)
          const remaining = yield* index.listChunks()
          expect(remaining.filter((chunk) => chunk.path === "sessions/ses_abc123.md").length).toBe(0)
          yield* index.close()
        }),
      ),
    ),
  )
})
