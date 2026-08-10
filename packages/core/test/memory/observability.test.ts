import { describe, expect, beforeEach, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  getMemoryStats,
  resetMemoryStatsForTests,
  recordFlushSuccess,
  recordFlushNoReply,
  recordFlushFailed,
  recordConsolidate,
  persistConsolidateStatus,
  loadConsolidateStatus,
} from "../../src/memory/observability"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Memory observability", () => {
  beforeEach(() => {
    resetMemoryStatsForTests()
  })

  test("process-local counters accumulate flush and consolidate outcomes", () => {
    recordFlushSuccess()
    recordFlushSuccess()
    recordFlushNoReply()
    recordFlushFailed("atomic")
    recordConsolidate({ status: "completed", sourcesMerged: 3 })
    const s = getMemoryStats()
    expect(s.flushSuccess).toBe(2)
    expect(s.flushNoReply).toBe(1)
    expect(s.flushFailed).toBe(1)
    expect(s.sourcesMerged).toBe(3)
    expect(s.lastConsolidateStatus).toBe("completed")
    expect(s.lastConsolidateAt).toBeGreaterThan(0)
  })

  it.effect("persist and load consolidation.status.json under base dir", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const base = path.join(dir.path, "mem")
          yield* fs.ensureDir(base)
          const ok = yield* persistConsolidateStatus(fs, base, "failed", "threat in output")
          expect(ok).toBe(true)
          const loaded = yield* loadConsolidateStatus(fs, base)
          expect(loaded.lastConsolidateStatus).toBe("failed")
          expect(loaded.lastConsolidateReason).toBe("threat in output")
          expect(loaded.lastConsolidateAt).toBeGreaterThan(0)
        }),
      ),
    ),
  )

  it.effect("load returns never when status file missing", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const loaded = yield* loadConsolidateStatus(fs, path.join(dir.path, "empty"))
          expect(loaded.lastConsolidateStatus).toBe("never")
        }),
      ),
    ),
  )
})
