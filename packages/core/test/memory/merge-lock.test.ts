import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots } from "../../src/memory/storage"
import { acquireMergeLock, releaseMergeLock, markConsolidated, lastConsolidatedAt, refreshMergeLock, STALE_LOCK_SECS } from "../../src/memory/merge-lock"
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

  it.effect("reclaim does not steal a fresh lock another holder just created", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const realFs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const lockFile = path.join(roots.globalDir, "consolidation.lock")
          // P2's staleness check saw an OLD lock; by reclaim time P1's FRESH
          // lock is in place. Simulate that stale snapshot via a lying stat.
          yield* acquireMergeLock(realFs, roots)
          const old = new Date(Date.now() - (STALE_LOCK_SECS + 60) * 1000)
          const staleSnapshotFs: FSUtil.Interface = {
            ...realFs,
            stat: (p: string) =>
              p === lockFile
                ? realFs.stat(p).pipe(Effect.map((info) => ({ ...info, mtime: Option.some(old) })))
                : realFs.stat(p),
          }
          const acquired = yield* acquireMergeLock(staleSnapshotFs, roots)
          expect(acquired).toBe(false)
          expect(yield* realFs.exists(lockFile)).toBe(true)
          yield* releaseMergeLock(realFs, roots)
        }),
      ),
    ),
  )

  it.effect("refreshMergeLock renews a lock that would otherwise look stale", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          yield* acquireMergeLock(fs, roots)
          const lockFile = path.join(roots.globalDir, "consolidation.lock")
          // Age the lock beyond the stale threshold, then heartbeat-refresh it.
          const old = new Date(Date.now() - (STALE_LOCK_SECS + 60) * 1000)
          yield* fs.utimes(lockFile, old, old)
          yield* refreshMergeLock(fs, roots)
          expect(yield* acquireMergeLock(fs, roots)).toBe(false)
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
