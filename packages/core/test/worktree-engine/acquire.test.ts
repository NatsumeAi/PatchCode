import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { WorktreeEngine } from "@opencode-ai/core/worktree-engine"
import { git } from "../fixture/git"
import { tmpdir } from "../fixture/tmpdir"
import { it } from "../lib/effect"

const skipWin = process.platform === "win32"

const initRepo = async (dir: string) => {
  await git(dir, "init", "-b", "main")
  await git(dir, "config", "user.email", "test@example.com")
  await git(dir, "config", "user.name", "Test")
  await fs.writeFile(path.join(dir, "README.md"), "one\n")
  await git(dir, "add", "README.md")
  await git(dir, "commit", "-m", "initial")
}

afterEach(() => {
  WorktreeEngine.resetState()
})

describe("W6 git acquire", () => {
  if (skipWin) {
    it.live.skip("skipped on win32", () => Effect.void)
    return
  }

  it.live("acquire two children with HEAD files; parent unchanged", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      const parentBefore = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "README.md"), "utf8"))
      const a = yield* WorktreeEngine.acquire({ projectRoot: tmp.path, id: "a" })
      const b = yield* WorktreeEngine.acquire({ projectRoot: tmp.path, id: "b" })
      expect(a.backend).toBe("git")
      expect(b.backend).toBe("git")
      expect(a.dir).not.toBe(b.dir)
      expect(yield* Effect.promise(() => fs.readFile(path.join(a.dir, "README.md"), "utf8"))).toBe("one\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(b.dir, "README.md"), "utf8"))).toBe("one\n")
      expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "README.md"), "utf8"))).toBe(parentBefore)
      yield* WorktreeEngine.discard({ projectRoot: tmp.path, id: "a" })
      yield* WorktreeEngine.discard({ projectRoot: tmp.path, id: "b" })
    }),
  )

  it.live("release then acquire can reuse a pool dir", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      const a = yield* WorktreeEngine.acquire({ projectRoot: tmp.path, id: "a" })
      const firstDir = a.dir
      expect(path.basename(firstDir)).toMatch(/^pool-/)
      yield* WorktreeEngine.discard({ projectRoot: tmp.path, id: "a" })
      const c = yield* WorktreeEngine.acquire({ projectRoot: tmp.path, id: "c" })
      expect(c.dir).toBe(firstDir)
      yield* WorktreeEngine.discard({ projectRoot: tmp.path, id: "c" })
    }),
  )

  it.live("fifth live acquire is Busy", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      for (const id of ["a", "b", "c", "d"]) {
        yield* WorktreeEngine.acquire({ projectRoot: tmp.path, id })
      }
      const fifth = yield* Effect.flip(WorktreeEngine.acquire({ projectRoot: tmp.path, id: "e" }))
      expect(fifth._tag).toBe("Worktree.Busy")
    }),
  )

  it.live("isolation worktree cwd is acquire dir, parent is unchanged", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      const wt = yield* WorktreeEngine.acquire({ projectRoot: tmp.path, id: "iso" })
      expect(wt.dir).not.toBe(tmp.path)
      yield* Effect.promise(() => fs.writeFile(path.join(wt.dir, "child-only.txt"), "from-child\n"))
      expect(yield* Effect.promise(() => fs.readFile(path.join(wt.dir, "child-only.txt"), "utf8"))).toBe("from-child\n")
      const parentHas = yield* Effect.promise(() =>
        fs.access(path.join(tmp.path, "child-only.txt")).then(
          () => true,
          () => false,
        ),
      )
      expect(parentHas).toBe(false)
      yield* WorktreeEngine.discard({ projectRoot: tmp.path, id: "iso" })
    }),
  )

  it.live("merge copies a symlink as a symlink, not target contents", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      const wt = yield* WorktreeEngine.acquire({ projectRoot: tmp.path, id: "link" })
      const secret = path.join(tmp.path, "secret.txt")
      yield* Effect.promise(async () => {
        await fs.writeFile(secret, "host-secret\n")
        await fs.symlink(secret, path.join(wt.dir, "linked.txt"))
      })
      yield* WorktreeEngine.merge({ projectRoot: tmp.path, id: "link" })
      const dest = path.join(tmp.path, "linked.txt")
      const st = yield* Effect.promise(() => fs.lstat(dest))
      expect(st.isSymbolicLink()).toBe(true)
      yield* WorktreeEngine.discard({ projectRoot: tmp.path, id: "link" })
    }),
  )

  it.live("lease survives in-memory reset via disk", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      yield* WorktreeEngine.acquire({ projectRoot: tmp.path, id: "persist" })
      WorktreeEngine.resetState()
      const looked = WorktreeEngine.lookup(tmp.path, "persist")
      expect(looked?.id).toBe("persist")
      yield* WorktreeEngine.discard({ projectRoot: tmp.path, id: "persist" })
    }),
  )
})
