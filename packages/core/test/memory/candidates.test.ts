import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots } from "../../src/memory/storage"
import {
  writeCandidate,
  listCandidates,
  readCandidate,
  deleteCandidate,
  mergeKeyOf,
  NOISE_FLOOR_CHARS,
} from "../../src/memory/candidates"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Memory candidates", () => {
  test("merge key is a stable hex comment line", () => {
    const a = mergeKeyOf("note-1", "## Notes\nx")
    const b = mergeKeyOf("note-1", "## Notes\nx")
    const c = mergeKeyOf("note-2", "## Notes\nx")
    expect(a).toMatch(/^<!-- memory-candidate:[a-f0-9]+ -->$/)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  test("noise floor is 40 chars", () => {
    expect(NOISE_FLOOR_CHARS).toBe(40)
  })

  it.effect("write then list returns one candidate with id", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          yield* writeCandidate(fs, roots, "note-1", "## Notes\nremember to verify")
          const list = yield* listCandidates(fs, roots, 0)
          expect(list.length).toBe(1)
          expect(list[0]!.id).toBe("note-1")
          const text = yield* readCandidate(fs, roots, "note-1")
          expect(text).toContain("remember to verify")
          yield* deleteCandidate(fs, roots, "note-1")
          const after = yield* listCandidates(fs, roots, 0)
          expect(after.length).toBe(0)
        }),
      ),
    ),
  )

  it.effect("list respects the since watermark and sorts by mtime", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          yield* writeCandidate(fs, roots, "a", "## A\ncontent a")
          yield* writeCandidate(fs, roots, "b", "## B\ncontent b")
          const all = yield* listCandidates(fs, roots, 0)
          expect(all.map((item) => item.id)).toEqual(["a", "b"])
          const recent = yield* listCandidates(fs, roots, Date.now() + 60_000)
          expect(recent.length).toBe(0)
        }),
      ),
    ),
  )
})
