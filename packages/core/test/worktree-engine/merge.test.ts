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

describe("W6 previewDiff and merge", () => {
  if (skipWin) {
    it.live.skip("skipped on win32", () => Effect.void)
    return
  }

  it.live("child write shows in previewDiff; parent unchanged until merge", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      const handle = yield* WorktreeEngine.acquire({ projectRoot: tmp.path, id: "child" })
      yield* Effect.promise(() => fs.writeFile(path.join(handle.dir, "README.md"), "two\n"))
      const diff = yield* WorktreeEngine.previewDiff({ projectRoot: tmp.path, id: "child" })
      expect(diff).toContain("README.md")
      expect(diff).toContain("two")
      expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "README.md"), "utf8"))).toBe("one\n")
      yield* WorktreeEngine.merge({ projectRoot: tmp.path, id: "child" })
      expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "README.md"), "utf8"))).toBe("two\n")
      yield* WorktreeEngine.discard({ projectRoot: tmp.path, id: "child" })
    }),
  )

  it.live("dirty parent same path fails merge and keeps parent bytes", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      const handle = yield* WorktreeEngine.acquire({ projectRoot: tmp.path, id: "child" })
      yield* Effect.promise(() => fs.writeFile(path.join(handle.dir, "README.md"), "child\n"))
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "README.md"), "parent-dirty\n"))
      const result = yield* Effect.flip(WorktreeEngine.merge({ projectRoot: tmp.path, id: "child" }))
      expect(result._tag).toBe("Worktree.DirtyParent")
      expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "README.md"), "utf8"))).toBe("parent-dirty\n")
      yield* WorktreeEngine.discard({ projectRoot: tmp.path, id: "child" })
    }),
  )
})
