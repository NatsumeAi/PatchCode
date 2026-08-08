import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots, memoryDir, readTextSafe, writeTextAtomic } from "../../src/memory/storage"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Memory storage", () => {
  test("resolveRoots maps global base and workspace project dir", () => {
    const roots = resolveRoots("/base/memory", "/proj")
    expect(roots.globalDir).toBe("/base/memory")
    expect(roots.workspaceDir).toBe("/proj/.opencode/memory")
  })

  test("resolveRoots omits workspace when project directory is absent", () => {
    expect(resolveRoots("/base/memory", undefined).workspaceDir).toBeUndefined()
  })

  test("memoryDir rejects paths escaping the root", () => {
    const roots = resolveRoots("/base/memory", "/proj")
    expect(() => memoryDir(roots, "../evil")).toThrow()
    expect(() => memoryDir(roots, "/abs/path")).toThrow()
  })

  it.effect("writeTextAtomic then readTextSafe round-trips", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const file = `${dir.path}/mem/MEMORY.md`
          yield* writeTextAtomic(fs, file, "line1\nline2")
          const text = yield* readTextSafe(fs, file)
          expect(text).toBe("line1\nline2")
        }),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ),
  )

  it.effect("writeTextAtomic reports false when the rename fails", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          // A directory at the target path makes the atomic rename fail (EISDIR).
          const file = `${dir.path}/mem/MEMORY.md`
          yield* fs.makeDirectory(file, { recursive: true })
          const ok = yield* writeTextAtomic(fs, file, "line1\nline2")
          expect(ok).toBe(false)
        }),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ),
  )

  it.effect("readTextSafe returns undefined for missing file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      () =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const text = yield* readTextSafe(fs, "/nonexistent/never.md")
          expect(text).toBeUndefined()
        }),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ),
  )
})
