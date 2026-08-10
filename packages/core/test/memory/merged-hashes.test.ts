import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import {
  contentHash,
  loadMergedHashes,
  appendMergedHashes,
  isAlreadyMerged,
  mergedHashesPath,
} from "../../src/memory/merged-hashes"
import { readTextSafe } from "../../src/memory/storage"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Memory merged hashes", () => {
  test("contentHash is stable sha256 hex of id\\ntext", () => {
    const a = contentHash("note:a.md", "hello")
    const b = contentHash("note:a.md", "hello")
    const c = contentHash("note:b.md", "hello")
    expect(a).toMatch(/^[a-f0-9]{64}$/)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  test("isAlreadyMerged checks the set", () => {
    const hash = contentHash("note:a.md", "body")
    const set = new Set([hash])
    expect(isAlreadyMerged(set, "note:a.md", "body")).toBe(true)
    expect(isAlreadyMerged(set, "note:a.md", "other")).toBe(false)
  })

  it.effect("load returns empty set when ledger missing", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const set = yield* loadMergedHashes(fs, dir.path)
          expect(set.size).toBe(0)
        }),
      ),
    ),
  )

  it.effect("append then load round-trips and is idempotent", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const h1 = contentHash("note:a.md", "one")
          const h2 = contentHash("session:b.md", "two")
          expect(yield* appendMergedHashes(fs, dir.path, [h1, h2])).toBe(true)
          const set = yield* loadMergedHashes(fs, dir.path)
          expect(set.has(h1)).toBe(true)
          expect(set.has(h2)).toBe(true)
          // Re-append same hashes is a no-op success.
          expect(yield* appendMergedHashes(fs, dir.path, [h1])).toBe(true)
          const text = yield* readTextSafe(fs, mergedHashesPath(dir.path))
          const lines = (text ?? "").trim().split("\n").filter(Boolean)
          expect(lines).toHaveLength(2)
          const h3 = contentHash("cand:c.md", "three")
          expect(yield* appendMergedHashes(fs, dir.path, [h3])).toBe(true)
          const after = yield* loadMergedHashes(fs, dir.path)
          expect(after.size).toBe(3)
        }),
      ),
    ),
  )
})
