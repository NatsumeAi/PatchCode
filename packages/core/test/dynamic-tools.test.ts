import { describe, expect } from "bun:test"
import { Effect, Layer, Schema, Scope } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { DynamicTools } from "@opencode-ai/core/tool/dynamic"
import { Tools } from "@opencode-ai/core/tool/tools"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"

const makeTool = (name: string) =>
  Tool.make({
    description: `Dynamic tool ${name}`,
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: ({ text }) => Effect.succeed({ text }),
    toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
  })

const hostLayer = Layer.succeed(
  DynamicTools.HostService,
  DynamicTools.HostService.of({
    install: Effect.gen(function* () {
      const tools = yield* Tools.Service
      const scope = yield* Scope.Scope
      yield* tools
        .register({
          playwright_click: makeTool("playwright_click"),
          oh_my_agent_run: makeTool("oh_my_agent_run"),
        })
        .pipe(Effect.orDie, Scope.provide(scope))
    }),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([ApplicationTools.node, Database.node, EventV2.node, LocationServiceMap.node]),
  ).pipe(Layer.provideMerge(hostLayer)),
)

describe("DynamicTools install into V2 ToolRegistry", () => {
  it.live("registers host-provided MCP/plugin tools into materialize definitions", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.scoped(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const locationRef = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const registry = yield* Effect.service(ToolRegistry.Service).pipe(
              Effect.provide(locations.get(locationRef)),
            )
            const definitions = yield* toolDefinitions(registry).pipe(Effect.provide(locations.get(locationRef)))
            const names = definitions.map((definition) => definition.name).sort()
            expect(names).toContain("playwright_click")
            expect(names).toContain("oh_my_agent_run")
          }),
        ),
      ),
    ),
  )

  it.live("settles a dynamic tool through the V2 materialization", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.scoped(
          Effect.gen(function* () {
            const locations = yield* LocationServiceMap.Service
            const locationRef = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
            const registry = yield* Effect.service(ToolRegistry.Service).pipe(
              Effect.provide(locations.get(locationRef)),
            )
            const materialized = yield* registry.materialize().pipe(Effect.provide(locations.get(locationRef)))
            const result = yield* materialized.settle({
              sessionID: SessionV2.ID.make("ses_dynamic"),
              agent: AgentV2.ID.make("build"),
              assistantMessageID: SessionMessage.ID.make("msg_dynamic"),
              call: { type: "tool-call", id: "call_dyn", name: "playwright_click", input: { text: "ok" } },
            })
            expect(result.result).toEqual({ type: "text", value: "ok" })
          }),
        ),
      ),
    ),
  )
})
