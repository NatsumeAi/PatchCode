import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots } from "../../src/memory/storage"
import { acquireMergeLock, releaseMergeLock, markConsolidated, lastConsolidatedAt, STALE_LOCK_SECS } from "../../src/memory/merge-lock"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Merge lock", () => {
  test("stale threshold is 3600s", () => {
    expect(STALE_LOCK_SECS).toBe(3600)
  })

  it.effect("acquire is exclusive", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          expect(yield* acquireMergeLock(fs, roots)).toBe(true)
          expect(yield* acquireMergeLock(fs, roots)).toBe(false)
          yield* releaseMergeLock(fs, roots)
          expect(yield* acquireMergeLock(fs, roots)).toBe(true)
          yield* releaseMergeLock(fs, roots)
        }),
      ),
    ),
  )

  it.effect("stale lock is reclaimed", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          yield* acquireMergeLock(fs, roots)
          // Backdate the lock file so it looks stale.
          const old = new Date(Date.now() - (STALE_LOCK_SECS + 60) * 1000)
          yield* fs.writeFileString(path.join(roots.globalDir, "consolidation.lock"), "x")
          yield* fs.utimes(path.join(roots.globalDir, "consolidation.lock"), old, old)
          expect(yield* acquireMergeLock(fs, roots)).toBe(true)
          yield* releaseMergeLock(fs, roots)
        }),
      ),
    ),
  )

  it.effect("markConsolidated records last consolidation time", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          expect(yield* lastConsolidatedAt(fs, roots)).toBeUndefined()
          yield* markConsolidated(fs, roots)
          const at = yield* lastConsolidatedAt(fs, roots)
          expect(at).toBeDefined()
          expect(Date.now() - at!).toBeLessThan(10_000)
        }),
      ),
    ),
  )
})
