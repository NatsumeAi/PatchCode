import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { ExecuteTool } from "@opencode-ai/core/tool/execute"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Tools } from "@opencode-ai/core/tool/tools"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"
import { tempLocationLayer } from "./fixture/location"

const sessionID = SessionV2.ID.make("ses_execute")
let pingCount = 0
let denyPing = false

const ping = Tool.make({
  description: "ping",
  input: Schema.Struct({}),
  output: Schema.Struct({ ok: Schema.Boolean }),
  execute: (_input, context) =>
    Effect.gen(function* () {
      if (denyPing) return yield* new Tool.Failure({ message: "Permission denied: ping" })
      pingCount++
      return { ok: true }
    }),
})

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    assertPolicyAsk: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const graph = AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ExecuteTool.node]), [
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  [PermissionV2.node, permission],
  [Location.node, tempLocationLayer],
])

const it = testEffect(graph)

describe("W8d CodeMode execute", () => {
  it.live("script return 1+1 outputs 2", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const names = (yield* toolDefinitions(registry)).map((item) => item.name)
      expect(names).toContain("execute")
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-add", name: "execute", input: { code: "return 1+1" } },
      })
      expect(result.type).not.toBe("error")
      expect(JSON.stringify(result)).toContain("2")
    }),
  )

  it.live("nested tools.ping goes through settle", () =>
    Effect.gen(function* () {
      pingCount = 0
      denyPing = false
      const tools = yield* Tools.Service
      yield* tools.register({ ping }).pipe(Effect.orDie)
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-nested",
          name: "execute",
          input: { code: "return await tools.ping({})" },
        },
      })
      expect(result.type).not.toBe("error")
      expect(pingCount).toBe(1)
    }),
  )

  it.live("inner permission deny is ToolFailure not success", () =>
    Effect.gen(function* () {
      denyPing = true
      const tools = yield* Tools.Service
      yield* tools.register({ ping }).pipe(Effect.orDie)
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-deny",
          name: "execute",
          input: { code: "return await tools.ping({})" },
        },
      })
      expect(result.type).toBe("error")
    }),
  )
})

describe("W8d execute is a builtin without experimental flag", () => {
  test("BuiltInTools source registers execute", async () => {
    const src = await Bun.file(new URL("../src/tool/builtins.ts", import.meta.url)).text()
    expect(src).toContain("ExecuteTool.node")
    expect(src).not.toContain("OPENCODE_EXPERIMENTAL_CODE_MODE")
    const execute = await Bun.file(new URL("../src/tool/execute.ts", import.meta.url)).text()
    expect(execute).toContain("materialized")
    expect(execute).toContain(".settle(")
  })
})
