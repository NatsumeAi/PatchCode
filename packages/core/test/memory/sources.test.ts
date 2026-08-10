import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { resolveRoots } from "../../src/memory/storage"
import { listMergeSources, budgetSources, deleteSources } from "../../src/memory/sources"
import { writeCandidate } from "../../src/memory/candidates"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(FSUtil.node))

describe("Memory sources", () => {
  test("budgetSources fills oldest-first until cap", () => {
    const mk = (id: string, n: number) =>
      ({
        kind: "note" as const,
        id,
        relativePath: id,
        absolutePath: `/tmp/${id}`,
        text: "x".repeat(n),
        mtime: 0,
      })
    const { included, overflow } = budgetSources([mk("a", 10), mk("b", 10), mk("c", 10)], 25)
    expect(included.map((s) => s.id)).toEqual(["a", "b"])
    expect(overflow.map((s) => s.id)).toEqual(["c"])
  })

  test("budgetSources includes a single oversize source so it is not stuck forever", () => {
    const huge = {
      kind: "note" as const,
      id: "huge",
      relativePath: "huge",
      absolutePath: "/tmp/huge",
      text: "y".repeat(100),
      mtime: 0,
    }
    const { included, overflow } = budgetSources([huge], 10)
    expect(included).toHaveLength(1)
    expect(overflow).toHaveLength(0)
  })

  it.effect("listMergeSources orders notes then sessions then candidates, each mtime asc", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const base = roots.globalDir
          yield* fs.ensureDir(path.join(base, "extensions", "ad_hoc", "notes"))
          yield* fs.ensureDir(path.join(base, "sessions"))
          const noteOld = path.join(base, "extensions", "ad_hoc", "notes", "n-old.md")
          const noteNew = path.join(base, "extensions", "ad_hoc", "notes", "n-new.md")
          const sessOld = path.join(base, "sessions", "s-old.md")
          const sessNew = path.join(base, "sessions", "s-new.md")
          yield* fs.writeFileString(noteOld, "## Note old\n".padEnd(50, "a"))
          yield* fs.writeFileString(noteNew, "## Note new\n".padEnd(50, "b"))
          yield* fs.writeFileString(sessOld, "## Session old\n".padEnd(50, "c"))
          yield* fs.writeFileString(sessNew, "## Session new\n".padEnd(50, "d"))
          yield* writeCandidate(fs, roots, "c-old", "## Cand old\n".padEnd(50, "e"))
          yield* writeCandidate(fs, roots, "c-new", "## Cand new\n".padEnd(50, "f"))
          const candOld = path.join(base, "extensions", "ad_hoc", "candidates", "c-old.md")
          const candNew = path.join(base, "extensions", "ad_hoc", "candidates", "c-new.md")
          // Force distinct mtimes so ordering is deterministic across filesystems.
          const t0 = Date.now() - 60_000
          yield* Effect.promise(async () => {
            const { utimes } = await import("fs/promises")
            await utimes(noteOld, new Date(t0), new Date(t0))
            await utimes(noteNew, new Date(t0 + 1000), new Date(t0 + 1000))
            await utimes(sessOld, new Date(t0 + 2000), new Date(t0 + 2000))
            await utimes(sessNew, new Date(t0 + 3000), new Date(t0 + 3000))
            await utimes(candOld, new Date(t0 + 4000), new Date(t0 + 4000))
            await utimes(candNew, new Date(t0 + 5000), new Date(t0 + 5000))
          })

          const sources = yield* listMergeSources(fs, roots)
          expect(sources.map((s) => s.kind)).toEqual([
            "note",
            "note",
            "session",
            "session",
            "candidate",
            "candidate",
          ])
          expect(sources.map((s) => s.id)).toEqual([
            "note:n-old.md",
            "note:n-new.md",
            "session:s-old.md",
            "session:s-new.md",
            "cand:c-old.md",
            "cand:c-new.md",
          ])
          expect(sources[0]!.mtime).toBeLessThan(sources[1]!.mtime)
          expect(sources[2]!.mtime).toBeLessThan(sources[3]!.mtime)
          expect(sources[4]!.mtime).toBeLessThan(sources[5]!.mtime)
          expect(sources[0]!.relativePath).toBe("extensions/ad_hoc/notes/n-old.md")
          expect(sources[0]!.absolutePath).toContain("n-old.md")
        }),
      ),
    ),
  )

  it.effect("listMergeSources tolerates empty dirs", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const sources = yield* listMergeSources(fs, roots)
          expect(sources).toEqual([])
        }),
      ),
    ),
  )

  it.effect("deleteSources removes listed files and ignores missing", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "mem"), undefined)
          const notes = path.join(roots.globalDir, "extensions", "ad_hoc", "notes")
          yield* fs.ensureDir(notes)
          const file = path.join(notes, "gone.md")
          yield* fs.writeFileString(file, "content enough for a note file body")
          const sources = yield* listMergeSources(fs, roots)
          expect(sources).toHaveLength(1)
          yield* deleteSources(fs, sources)
          yield* deleteSources(fs, sources) // missing ok
          const after = yield* listMergeSources(fs, roots)
          expect(after).toHaveLength(0)
        }),
      ),
    ),
  )
})
