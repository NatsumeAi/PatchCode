import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Hooks } from "@opencode-ai/core/hooks"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Tools } from "@opencode-ai/core/tool/tools"
import { Trust } from "@opencode-ai/core/trust"
import { testEffect } from "../lib/effect"
import { executeTool } from "../lib/tool"

let starts = 0
let persisted: "pending" | "allow" | "deny" = "pending"

const dummy = Tool.make({
  description: "n",
  input: Schema.Struct({}),
  output: Schema.Struct({ ok: Schema.Boolean }),
  execute: () => Effect.succeed({ ok: true }),
})

const hooks = Layer.succeed(
  Hooks.Service,
  Hooks.Service.of({
    load: () => Effect.succeed([]),
    dispatch: (input) =>
      Effect.sync(() => {
        if (input.event === "SessionStart") {
          starts++
          return { _tag: "Deny" as const, reason: "no", hookId: "start" }
        }
        return { _tag: "Allow" as const }
      }),
    register: () => Effect.void,
    list: () => Effect.succeed({ loaded: [], untrusted: false }),
    ensureSessionStart: () =>
      Effect.sync(() => {
        if (persisted === "allow") return { _tag: "Allow" as const }
        if (persisted === "deny")
          return { _tag: "Deny" as const, reason: "session blocked by SessionStart hook", hookId: "session-start" }
        starts++
        persisted = "deny"
        return { _tag: "Deny" as const, reason: "no", hookId: "start" }
      }),
    trust: (absPath) => Effect.promise(() => Trust.grant(absPath)),
    reload: () => Effect.void,
  }),
)

const it = testEffect(
  Layer.provideMerge(
    AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode]), [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ]),
    hooks,
  ),
)

const call = {
  sessionID: SessionV2.ID.make("ses_hooks_start"),
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_hooks_start"),
  call: { type: "tool-call" as const, id: "call-dummy", name: "dummy", input: {} },
}

describe("W5 SessionStart gate", () => {
  it.effect("denied session blocks settle and reconnect does not re-fire", () =>
    Effect.gen(function* () {
      starts = 0
      persisted = "pending"
      const tools = yield* Tools.Service
      yield* tools.register({ dummy })
      const registry = yield* ToolRegistry.Service
      const first = yield* executeTool(registry, call)
      expect(first).toEqual({ type: "error", value: "session blocked by SessionStart hook" })
      expect(starts).toBe(1)
      const second = yield* executeTool(registry, call)
      expect(second).toEqual({ type: "error", value: "session blocked by SessionStart hook" })
      expect(starts).toBe(1)
    }),
  )
})
