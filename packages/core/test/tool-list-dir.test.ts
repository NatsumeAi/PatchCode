import fs from "fs/promises"
import { readFile } from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { BuiltInTools } from "@opencode-ai/core/tool/builtins"
import { ListDirTool } from "@opencode-ai/core/tool/list-dir"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, toolDefinitions } from "./lib/tool"

const sessionID = Session.ID.make("ses_list_dir_tool_test")
const assertions: Permission.AssertInput[] = []
const listCalls: ReadToolFileSystem.PageInput[] = []
let allow = true

const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
      }).pipe(Effect.andThen(allow ? Effect.void : Effect.fail(new Permission.BlockedError({ rules: [] })))),
    assertPolicyAsk: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const reset = () => {
  assertions.length = 0
  listCalls.length = 0
  allow = true
}

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
          ListDirTool.node,
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

const withMockedTool = <A, E, R>(body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  const reader = Layer.succeed(
    ReadToolFileSystem.Service,
    ReadToolFileSystem.Service.of({
      inspect: () => Effect.succeed("directory" as const),
      read: () => Effect.die("unused"),
      list: (_path, input = {}) =>
        Effect.sync(() => {
          listCalls.push(input)
          return new ReadToolFileSystem.ListPage({ entries: [], truncated: false })
        }),
    }),
  )
  const mutation = Layer.succeed(
    LocationMutation.Service,
    LocationMutation.Service.of({
      resolve: (input) => {
        const canonical = path.resolve(process.cwd(), input.path)
        const external = path.isAbsolute(input.path) && !FSUtil.contains(process.cwd(), canonical)
        const resource = external ? canonical.replaceAll("\\", "/") : path.relative(process.cwd(), canonical) || "."
        const directory = path.dirname(canonical)
        const externalResource = path.join(directory, "*").replaceAll("\\", "/")
        return Effect.succeed({
          canonical,
          resource,
          externalDirectory: external
            ? {
                action: "external_directory" as const,
                directory,
                resource: externalResource,
                save: externalResource,
              }
            : undefined,
        })
      },
    }),
  )
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(process.cwd()) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ListDirTool.node]),
        [
          [ReadToolFileSystem.node, reader],
          [LocationMutation.node, mutation],
          [FSUtil.node, LayerNode.compile(FSUtil.node)],
          [Location.node, locationLayer],
          [Permission.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (input: { path: string; offset?: number; limit?: number }, id = "call-list-dir") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "list_dir", input },
})

const it = testEffect(Layer.empty)

describe("ListDirTool", () => {
  it.effect("registers list_dir in tool definitions", () =>
    Effect.gen(function* () {
      reset()
      yield* withMockedTool((registry) =>
        Effect.gen(function* () {
          expect(yield* toolDefinitions(registry)).toMatchObject([{ name: "list_dir" }])
          expect(yield* toolDefinitions(registry, [{ action: "read", resource: "*", effect: "deny" }])).toEqual([])
        }),
      )
    }),
  )

  it.live("lists files and directories in a temp directory", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(async () => {
          await fs.mkdir(path.join(tmp.path, "sub"))
          await fs.writeFile(path.join(tmp.path, "a.ts"), "")
        }).pipe(
          Effect.andThen(
            withLiveTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const result = yield* executeTool(registry, call({ path: "." }))
                expect(result).toMatchObject({ type: "json" })
                if (result.type !== "json") return
                const entries = result.value.entries as Array<{ path: string; type: string }>
                const names = entries.map((entry) => entry.path.replace(/[/\\]$/, ""))
                expect(names).toContain("a.ts")
                expect(names).toContain("sub")
                expect(entries.find((entry) => entry.path.startsWith("a.ts"))?.type).toBe("file")
                expect(entries.find((entry) => entry.path.startsWith("sub"))?.type).toBe("directory")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.effect("asks for external_directory approval before listing an external absolute path", () =>
    Effect.gen(function* () {
      reset()
      yield* withMockedTool((registry) =>
        Effect.gen(function* () {
          const external = path.join(path.parse(process.cwd()).root, "external-list-dir")

          expect(yield* executeTool(registry, call({ path: external }))).toMatchObject({ type: "json" })
          expect(assertions).toMatchObject([
            {
              sessionID,
              action: "external_directory",
              resources: [path.join(path.dirname(external), "*").replaceAll("\\", "/")],
            },
            { sessionID, action: "read", resources: [external.replaceAll("\\", "/")], save: ["*"] },
          ])
        }),
      )
    }),
  )

  it.live("paginates directory listings with offset and limit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(async () => {
          await fs.mkdir(path.join(tmp.path, "sub"))
          await fs.writeFile(path.join(tmp.path, "a.ts"), "")
          await fs.writeFile(path.join(tmp.path, "b.ts"), "")
        }).pipe(
          Effect.andThen(
            withLiveTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const first = yield* executeTool(registry, call({ path: ".", limit: 1 }))
                expect(first).toMatchObject({ type: "json" })
                if (first.type !== "json") return
                expect(first.value.entries).toHaveLength(1)
                expect(first.value.truncated).toBe(true)
                expect(first.value.next).toBe(2)

                const second = yield* executeTool(
                  registry,
                  call({ path: ".", offset: first.value.next, limit: 1 }, "call-list-dir-page-2"),
                )
                expect(second).toMatchObject({ type: "json" })
                if (second.type !== "json") return
                expect(second.value.entries).toHaveLength(1)
                expect(second.value.entries[0]?.path.replace(/[/\\]$/, "")).not.toBe(
                  first.value.entries[0]?.path.replace(/[/\\]$/, ""),
                )
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.effect("does not list when permission is denied", () =>
    Effect.gen(function* () {
      reset()
      allow = false
      yield* withMockedTool((registry) =>
        Effect.gen(function* () {
          expect(yield* executeTool(registry, call({ path: "." }))).toEqual({
            type: "error",
            value: "Unable to list .",
          })
          expect(listCalls).toEqual([])
        }),
      )
    }),
  )

  it.effect("does not import AppProcess or spawn", () =>
    Effect.gen(function* () {
      const source = yield* Effect.promise(() =>
        readFile(new URL("../src/tool/list-dir.ts", import.meta.url), "utf8"),
      )
      expect(source).not.toContain("AppProcess")
      expect(source).not.toMatch(/\bspawn\b/)
    }),
  )
})

test("built-in tools node includes list_dir", () => {
  expect(BuiltInTools.node.dependencies.some((dep) => dep.name === "tool/list-dir")).toBe(true)
})
