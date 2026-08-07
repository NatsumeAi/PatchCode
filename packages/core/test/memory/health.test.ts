import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots } from "../../src/memory/storage"
import { writeTextAtomic } from "../../src/memory/storage"
import { collectHealth } from "../../src/memory/health"
import { openMemoryIndex } from "../../src/memory/reindex"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Memory health", () => {
  it.effect("counts files, bytes, and index chunks by source", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          yield* writeTextAtomic(fs, path.join(roots.globalDir, "MEMORY.md"), "## Decisions\nuse layers")
          const index = yield* openMemoryIndex(fs, roots)
          yield* index.insert("global", {
            path: "MEMORY.md",
            source: "global",
            text: "use layers",
            startLine: 1,
            endLine: 2,
            mtimeMs: Date.now(),
          })
          const health = yield* collectHealth(fs, roots, index)
          expect(health.files).toBeGreaterThan(0)
          expect(health.totalBytes).toBeGreaterThan(0)
          expect(health.bySource.global).toBeGreaterThan(0)
          expect(health.chunks).toBeGreaterThan(0)
          expect(health.zeroAccessChunks).toBe(1)
          expect(health.pruneCandidates).toBe(0)
          yield* index.close()
        }),
      ),
    ),
  )
})
