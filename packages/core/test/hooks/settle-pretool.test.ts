import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Hooks } from "@opencode-ai/core/hooks"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Session } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Tools } from "@opencode-ai/core/tool/tools"
import { Trust } from "@opencode-ai/core/trust"
import { testEffect } from "../lib/effect"
import { executeTool } from "../lib/tool"

let executes = 0
let posts = 0
let failures = 0
let denyPre = false
let failExecute = false

const dummy = Tool.make({
  description: "counter",
  input: Schema.Struct({}),
  output: Schema.Struct({ ok: Schema.Boolean }),
  execute: () =>
    Effect.gen(function* () {
      executes++
      if (failExecute) return yield* new Tool.Failure({ message: "boom" })
      return { ok: true }
    }),
})

const hooks = Layer.succeed(
  Hooks.Service,
  Hooks.Service.of({
    load: () => Effect.succeed([]),
    dispatch: (input) =>
      Effect.sync(() => {
        if (input.event === "PreToolUse" && denyPre)
          return { _tag: "Deny" as const, reason: "x", hookId: "test-deny" }
        if (input.event === "PostToolUse") posts++
        if (input.event === "PostToolUseFailure") failures++
        return { _tag: "Allow" as const }
      }),
    register: () => Effect.void,
    list: () => Effect.succeed({ loaded: [], untrusted: false }),
    ensureSessionStart: () => Effect.succeed({ _tag: "Allow" as const }),
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
  sessionID: Session.ID.make("ses_hooks_settle"),
  agent: Agent.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_hooks_settle"),
  call: { type: "tool-call" as const, id: "call-dummy", name: "dummy", input: {} },
}

const readCall = {
  ...call,
  call: { type: "tool-call" as const, id: "call-read", name: "read", input: {} },
}

describe("W5 settle PreToolUse", () => {
  it.effect("deny prevents execute", () =>
    Effect.gen(function* () {
      executes = 0
      denyPre = true
      failExecute = false
      const tools = yield* Tools.Service
      yield* tools.register({ dummy })
      const result = yield* executeTool(yield* ToolRegistry.Service, call)
      expect(result).toEqual({ type: "error", value: "Hook denied: x" })
      expect(executes).toBe(0)
    }),
  )

  it.effect("allow runs execute and PostToolUse", () =>
    Effect.gen(function* () {
      executes = 0
      posts = 0
      denyPre = false
      failExecute = false
      const tools = yield* Tools.Service
      yield* tools.register({ dummy })
      const result = yield* executeTool(yield* ToolRegistry.Service, call)
      expect(result.type).not.toBe("error")
      expect(executes).toBe(1)
      expect(posts).toBe(1)
    }),
  )

  it.effect("ToolFailure fires PostToolUseFailure not PostToolUse", () =>
    Effect.gen(function* () {
      executes = 0
      posts = 0
      failures = 0
      denyPre = false
      failExecute = true
      const tools = yield* Tools.Service
      yield* tools.register({ dummy })
      yield* executeTool(yield* ToolRegistry.Service, call)
      expect(executes).toBe(1)
      expect(failures).toBe(1)
      expect(posts).toBe(0)
    }),
  )

  it.effect("read tool hits PreToolUse on settleWith", () =>
    Effect.gen(function* () {
      executes = 0
      denyPre = true
      failExecute = false
      const tools = yield* Tools.Service
      yield* tools.register({ read: dummy })
      const result = yield* executeTool(yield* ToolRegistry.Service, readCall)
      expect(result).toEqual({ type: "error", value: "Hook denied: x" })
      expect(executes).toBe(0)
    }),
  )
})
