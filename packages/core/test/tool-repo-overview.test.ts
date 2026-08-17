import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { RepoOverviewTool } from "@opencode-ai/core/tool/repo-overview"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_repo_overview")
const assertions: Permission.AssertInput[] = []

const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    assertPolicyAsk: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const withLiveTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          ReadToolFileSystem.node,
          RepoOverviewTool.node,
        ]),
        [
          [FSUtil.node, LayerNode.compile(FSUtil.node)],
          [Location.node, activeLocation],
          [Permission.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const it = testEffect(Layer.empty)

describe("W8f repo_overview", () => {
  it.live("summarizes README and ts files under the output cap", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          assertions.length = 0
          yield* Effect.promise(async () => {
            await writeFile(path.join(tmp.path, "README.md"), `${"line\n".repeat(100)}tail`)
            await writeFile(path.join(tmp.path, "a.ts"), "export const a = 1\n")
            await writeFile(path.join(tmp.path, "b.ts"), "export const b = 2\n")
            await mkdir(path.join(tmp.path, "src"))
          })
          const result = yield* withLiveTool(tmp.path, (registry) =>
            executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-ov", name: "repo_overview", input: {} },
            }),
          )
          expect(result.type).not.toBe("error")
          const text = JSON.stringify(result)
          expect(text).toContain("README")
          expect(text).toContain("ts")
          expect(text.length).toBeLessThan(16_384)
          expect(assertions.some((item) => item.action === "read")).toBe(true)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  test("repo-overview.ts does not spawn AppProcess", async () => {
    const src = await Bun.file(new URL("../src/tool/repo-overview.ts", import.meta.url)).text()
    expect(src).not.toContain("AppProcess")
  })
})
