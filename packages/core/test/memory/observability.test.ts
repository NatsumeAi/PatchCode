import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  getMemoryStats,
  hydrateFlushStats,
  persistFlushStats,
  recordConsolidate,
  recordFlushSuccess,
  resetMemoryStatsForTests,
} from "../../src/memory/observability"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Memory observability", () => {
  test("recordConsolidate does not demote completed to nothing (dual-root)", () => {
    resetMemoryStatsForTests()
    recordConsolidate({ status: "completed", sourcesMerged: 2 })
    expect(getMemoryStats().lastConsolidateStatus).toBe("completed")
    expect(getMemoryStats().sourcesMerged).toBe(2)
    // Global pass with nothing to do must not overwrite workspace success.
    recordConsolidate({ status: "nothing", reason: "no-sources" })
    expect(getMemoryStats().lastConsolidateStatus).toBe("completed")
    expect(getMemoryStats().sourcesMerged).toBe(2)
  })

  test("recordConsolidate can upgrade nothing to completed", () => {
    resetMemoryStatsForTests()
    recordConsolidate({ status: "nothing", reason: "no-sources" })
    recordConsolidate({ status: "completed", sourcesMerged: 1 })
    expect(getMemoryStats().lastConsolidateStatus).toBe("completed")
    expect(getMemoryStats().sourcesMerged).toBe(1)
  })

  it.effect("persist + hydrate flush stats survives process-local reset", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const base = path.join(dir.path, "mem")
          yield* fs.ensureDir(base)
          resetMemoryStatsForTests()
          recordFlushSuccess()
          recordFlushSuccess()
          expect(getMemoryStats().flushSuccess).toBe(2)
          expect(yield* persistFlushStats(fs, base)).toBe(true)
          resetMemoryStatsForTests()
          expect(getMemoryStats().flushSuccess).toBe(0)
          yield* hydrateFlushStats(fs, base)
          expect(getMemoryStats().flushSuccess).toBe(2)
        }),
      ),
    ),
  )
})
