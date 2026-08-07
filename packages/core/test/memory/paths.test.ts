import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type * as Scope from "effect/Scope"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveScoped, resolveScopedFile } from "../../src/memory/paths"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

const withDir = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
  ).pipe(Effect.flatMap((dir) => body(dir.path)))

describe("Memory scoped paths", () => {
  it.effect("resolves nested relative paths inside root", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        yield* fs.writeWithDirs(path.join(dir, "a/b.md"), "x")
        const resolved = yield* resolveScoped(fs, dir, "a/b.md")
        expect(resolved).toBe(path.join(dir, "a/b.md"))
      }),
    ),
  )

  it.effect("empty relative resolves to root", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const resolved = yield* resolveScoped(fs, dir, "")
        expect(resolved).toBe(dir)
      }),
    ),
  )

  it.effect("rejects parent traversal", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const exit = yield* resolveScoped(fs, dir, "../evil").pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.effect("rejects absolute paths", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const exit = yield* resolveScoped(fs, "/tmp", "/etc/passwd").pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("rejects hidden components", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const exit = yield* resolveScoped(fs, dir, ".secret.md").pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.effect("rejects symlink components", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const link = path.join(dir, "link")
        yield* Effect.promise(() => Bun.$`ln -s ${path.join(dir, "target")} ${link}`.quiet())
        const exit = yield* resolveScoped(fs, dir, "link/file.md").pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.effect("resolveScopedFile requires a regular file", () =>
    withDir((dir) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        yield* fs.writeWithDirs(path.join(dir, "note.md"), "x")
        const resolved = yield* resolveScopedFile(fs, dir, "note.md")
        expect(resolved).toBe(path.join(dir, "note.md"))
        const exit = yield* resolveScopedFile(fs, dir, "missing.md").pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
