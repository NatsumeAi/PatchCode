import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { Permission } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WorktreeTool } from "@opencode-ai/core/tool/worktree"
import { WorktreeEngine } from "@opencode-ai/core/worktree-engine"
import { git } from "../fixture/git"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { toolIdentity, executeTool } from "../lib/tool"

const skipWin = process.platform === "win32"
const sessionID = SessionV2.ID.make("ses_worktree_tool")

const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    assert: () => Effect.void,
    assertPolicyAsk: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const initRepo = async (dir: string) => {
  await git(dir, "init", "-b", "main")
  await git(dir, "config", "user.email", "test@example.com")
  await git(dir, "config", "user.name", "Test")
  await fs.writeFile(path.join(dir, "README.md"), "one\n")
  await git(dir, "add", "README.md")
  await git(dir, "commit", "-m", "initial")
}

const run = (directory: string, action: "diff" | "merge" | "discard", id: string) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    return yield* executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call" as const, id: `call-${action}`, name: "worktree", input: { action, id } },
    })
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, WorktreeTool.node]), [
        [
          Location.node,
          Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
          ),
        ],
        [Permission.node, permission],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ]),
    ),
  )

const it = testEffect(Layer.empty)

afterEach(() => {
  WorktreeEngine.resetState()
})

describe("W6 worktree tool", () => {
  if (skipWin) {
    it.live.skip("skipped on win32", () => Effect.void)
    return
  }

  it.live("diff merge discard against a live acquired worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(tmp.path))
      const handle = yield* WorktreeEngine.acquire({ projectRoot: tmp.path, id: "child" })
      yield* Effect.promise(() => fs.writeFile(path.join(handle.dir, "README.md"), "two\n"))
      const diff = yield* run(tmp.path, "diff", "child")
      expect(diff.type).not.toBe("error")
      const merge = yield* run(tmp.path, "merge", "child")
      expect(merge.type).not.toBe("error")
      expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "README.md"), "utf8"))).toBe("two\n")
      const discard = yield* run(tmp.path, "discard", "child")
      expect(discard.type).not.toBe("error")
    }),
  )
})
