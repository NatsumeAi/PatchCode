import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots, writeTextAtomic } from "../../src/memory/storage"
import {
  assertSandboxPath,
  defaultTransferAllowedRoots,
  exportMemory,
  importMemory,
} from "../../src/memory/transfer"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Memory transfer sandbox", () => {
  it.effect("assertSandboxPath allows a path under an allowed root", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const pack = path.join(dir.path, "memory-packs", "pack-a")
          const resolved = yield* assertSandboxPath(pack, [path.join(dir.path, "memory-packs")])
          expect(resolved).toBe(FSUtil.resolve(pack))
        }),
      ),
    ),
  )

  it.effect("assertSandboxPath rejects /etc/passwd style escape", () =>
    Effect.gen(function* () {
      const exit = yield* assertSandboxPath("/etc/passwd", ["/home/user/memory-packs"]).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("assertSandboxPath rejects empty allowed roots (fail closed)", () =>
    Effect.gen(function* () {
      const exit = yield* assertSandboxPath("/tmp/anything", []).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.effect("assertSandboxPath rejects parent traversal out of root", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const root = path.join(dir.path, "memory-packs")
          const escape = path.join(root, "..", "outside")
          const exit = yield* assertSandboxPath(escape, [root]).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
        }),
      ),
    ),
  )

  it.effect("exportMemory fails closed when target escapes sandbox", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          yield* writeTextAtomic(fs, path.join(roots.globalDir, "MEMORY.md"), "## Decisions\nuse layers")
          const outside = path.join(dir.path, "outside-pack")
          const exit = yield* exportMemory(fs, roots, outside, {
            includeRaw: false,
            allowedRoots: [path.join(dir.path, "memory-packs")],
          }).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          const exists = yield* fs.existsSafe(path.join(outside, "manifest.json"))
          expect(exists).toBe(false)
        }),
      ),
    ),
  )

  it.effect("importMemory fails closed when source escapes sandbox", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          yield* writeTextAtomic(fs, path.join(roots.globalDir, "MEMORY.md"), "## Decisions\nuse layers")
          const pack = path.join(dir.path, "memory-packs", "pack")
          yield* exportMemory(fs, roots, pack, {
            includeRaw: false,
            allowedRoots: [path.join(dir.path, "memory-packs")],
          })
          const otherRoots = resolveRoots(path.join(dir.path, "other"), undefined)
          const exit = yield* importMemory(fs, otherRoots, pack, {
            allowedRoots: [path.join(dir.path, "other-packs")],
          }).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          const text = yield* fs.readFileStringSafe(path.join(otherRoots.globalDir, "MEMORY.md")).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
          expect(text).toBeUndefined()
        }),
      ),
    ),
  )

  it.effect("export and import succeed under defaultTransferAllowedRoots", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          yield* writeTextAtomic(fs, path.join(roots.globalDir, "MEMORY.md"), "## Decisions\nuse layers")
          const allowed = defaultTransferAllowedRoots(dir.path, path.join(dir.path, "project"))
          const pack = path.join(dir.path, "memory-packs", "roundtrip")
          const exported = yield* exportMemory(fs, roots, pack, { includeRaw: false, allowedRoots: allowed })
          expect(exported.exported).toBeGreaterThan(0)
          const otherRoots = resolveRoots(path.join(dir.path, "other"), undefined)
          const result = yield* importMemory(fs, otherRoots, pack, { allowedRoots: allowed })
          expect(result.imported).toBeGreaterThan(0)
        }),
      ),
    ),
  )

  it.effect("allows project dir when listed in allowed roots", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const project = path.join(dir.path, "project")
          const pack = path.join(project, "my-pack")
          const resolved = yield* assertSandboxPath(pack, defaultTransferAllowedRoots(dir.path, project))
          expect(resolved).toBe(FSUtil.resolve(pack))
        }),
      ),
    ),
  )
})
