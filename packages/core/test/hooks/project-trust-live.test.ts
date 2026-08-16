import { describe, expect } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Hooks } from "@opencode-ai/core/hooks"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Tools } from "@opencode-ai/core/tool/tools"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { executeTool } from "../lib/tool"

const dummy = Tool.make({
  description: "n",
  input: Schema.Struct({}),
  output: Schema.Struct({ ok: Schema.Boolean }),
  execute: () => Effect.succeed({ ok: true }),
})

const call = {
  sessionID: SessionV2.ID.make("ses_hooks_trust"),
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_hooks_trust"),
  call: { type: "tool-call" as const, id: "call-dummy", name: "dummy", input: {} },
}

const events: Array<{ type: string; data: Record<string, unknown> }> = []

const eventLayer = Layer.succeed(
  EventV2.Service,
  {
    publish: (definition: { readonly type: string }, data: Record<string, unknown>) =>
      Effect.sync(() => {
        events.push({ type: definition.type, data })
        return { durable: { aggregateID: "ses_hooks_location", seq: events.length, version: 1 } }
      }),
  } as unknown as EventV2.Interface,
)

const graphFor = (directory: string) => {
  const current = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Layer.provideMerge(
    AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, Hooks.node]), [
      [Location.node, current],
      [EventV2.node, eventLayer],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ]),
    eventLayer,
  )
}

const it = testEffect(Layer.empty)

describe("W5 project hook trust live", () => {
  it.live("untrusted project hook does not run; trust then deny; publishes hooks.untrusted", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_CONFIG_DIR
      const configDir = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "oc-hooks-cfg-")))
      const repo = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "oc-hooks-repo-")))
      process.env.OPENCODE_CONFIG_DIR = configDir
      yield* Effect.promise(async () => {
        await mkdir(path.join(repo, ".opencode", "hooks"), { recursive: true })
        await writeFile(
          path.join(repo, ".opencode", "hooks", "deny.json"),
          JSON.stringify({
            version: 1,
            hooks: {
              PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "exit 2", timeout: 5 }] }],
            },
          }),
        )
      })
      events.length = 0
      try {
        const graph = graphFor(repo)
        yield* Effect.gen(function* () {
          const tools = yield* Tools.Service
          yield* tools.register({ dummy })
          const registry = yield* ToolRegistry.Service
          const hooks = yield* Hooks.Service
          const listed = yield* hooks.list()
          expect(listed.untrusted).toBe(true)
          expect(listed.loaded).toEqual([])
          expect(events.some((event) => event.data.source === "hooks.untrusted" || event.data.event === "untrusted")).toBe(
            true,
          )
          const allowed = yield* executeTool(registry, call)
          expect(allowed.type).not.toBe("error")
          yield* hooks.trust(repo)
          const after = yield* hooks.list()
          expect(after.untrusted).toBe(false)
          expect(after.loaded.length).toBe(1)
          const denied = yield* executeTool(registry, call)
          expect(denied).toEqual({ type: "error", value: expect.stringContaining("Hook denied") as unknown as string })
          expect(denied.type).toBe("error")
          if (denied.type === "error") expect(denied.value).toContain("Hook denied")
        }).pipe(Effect.provide(graph))
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
        else process.env.OPENCODE_CONFIG_DIR = previous
      }
    }),
  )
})
