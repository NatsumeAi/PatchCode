import { describe, expect, beforeEach } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots } from "../../src/memory/storage"
import { writeTextAtomic } from "../../src/memory/storage"
import { collectHealth, healthBases } from "../../src/memory/health"
import { openMemoryIndex } from "../../src/memory/reindex"
import { recordConsolidate, resetMemoryStatsForTests } from "../../src/memory/observability"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Memory health", () => {
  beforeEach(() => {
    resetMemoryStatsForTests()
  })

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
          expect(health.lastConsolidateStatus).toBe("never")
          expect(health.flushSuccess).toBe(0)
          yield* index.close()
        }),
      ),
    ),
  )

  it.effect("dual-root walk counts files under both global and workspace bases", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), path.join(dir.path, "proj"))
          expect(healthBases(roots)).toEqual([roots.globalDir, roots.workspaceDir!])
          yield* writeTextAtomic(fs, path.join(roots.globalDir, "MEMORY.md"), "global archive")
          yield* writeTextAtomic(fs, path.join(roots.workspaceDir!, "MEMORY.md"), "workspace archive")
          const index = yield* openMemoryIndex(fs, roots)
          const health = yield* collectHealth(fs, roots, index)
          expect(health.files).toBeGreaterThanOrEqual(2)
          yield* index.close()
        }),
      ),
    ),
  )

  it.effect("includes process-local consolidate status counters", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          recordConsolidate({ status: "completed", sourcesMerged: 2, reason: undefined })
          const index = yield* openMemoryIndex(fs, roots)
          const health = yield* collectHealth(fs, roots, index)
          expect(health.lastConsolidateStatus).toBe("completed")
          expect(health.sourcesMerged).toBe(2)
          expect(health.lastConsolidatedAt).toBeGreaterThan(0)
          yield* index.close()
        }),
      ),
    ),
  )

  it.effect("reports dream phases due now when no stamps exist", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const index = yield* openMemoryIndex(fs, roots)
          const health = yield* collectHealth(fs, roots, index)
          expect(health.dreamNextHint).toBe("light due now")
          expect(health.dreamLastLight).toBeUndefined()
          expect(health.dreamLastDeep).toBeUndefined()
          expect(health.dreamLastRem).toBeUndefined()
          yield* index.close()
        }),
      ),
    ),
  )

  it.effect("exposes dream stamps, next-due hint, recall filters, and citations mode", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          yield* writeTextAtomic(
            fs,
            path.join(roots.globalDir, "dream-phase.last.json"),
            JSON.stringify({ light: Date.now(), deep: Date.now(), rem: Date.now() }),
          )
          const index = yield* openMemoryIndex(fs, roots)
          const health = yield* collectHealth(fs, roots, index)
          expect(health.dreamLastLight).toBeTypeOf("number")
          expect(health.dreamLastDeep).toBeTypeOf("number")
          expect(health.dreamLastRem).toBeTypeOf("number")
          expect(health.dreamNextHint).toMatch(/^light due in ~\d+h$/)
          expect(health.recallMaxAgeDays).toBe(30)
          expect(health.recallMinScore).toBe(0.15)
          expect(health.citationsMode).toBe("auto")
          yield* index.close()
        }),
      ),
    ),
  )
})
