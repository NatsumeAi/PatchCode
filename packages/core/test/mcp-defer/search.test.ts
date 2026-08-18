import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Hooks } from "@opencode-ai/core/hooks"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Session } from "@opencode-ai/core/session"
import { SearchTool } from "@opencode-ai/core/tool/search-tool"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Tools } from "@opencode-ai/core/tool/tools"
import { UseTool } from "@opencode-ai/core/tool/use-tool"
import { Trust } from "@opencode-ai/core/trust"
import { testEffect } from "../lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "../lib/tool"

const sessionID = Session.ID.make("ses_mcp_defer")
const seen: string[] = []
let pingCount = 0

const dummy = (index: number) =>
  Tool.make({
    description: `dummy tool number ${index} for search`,
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
    execute: () =>
      Effect.sync(() => {
        if (index === 0) pingCount++
        return { ok: true }
      }),
  })

const hooks = Layer.succeed(
  Hooks.Service,
  Hooks.Service.of({
    load: () => Effect.succeed([]),
    dispatch: (input) =>
      Effect.sync(() => {
        if (input.event === "PreToolUse") seen.push(input.toolName ?? "")
        return { _tag: "Allow" as const }
      }),
    register: () => Effect.void,
    list: () => Effect.succeed({ loaded: [], untrusted: false }),
    ensureSessionStart: () => Effect.succeed({ _tag: "Allow" as const }),
    trust: (absPath) => Effect.promise(() => Trust.grant(absPath)),
    reload: () => Effect.void,
  }),
)

const config = (deferAfter: number) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          { type: "document" as const, info: { mcp: { deferAfter } } },
        ] as never),
      reload: () => Effect.void,
    }),
  )

const graph = (deferAfter: number) =>
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SearchTool.node, UseTool.node]), [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ]),
    hooks,
    config(deferAfter),
  )

const registerDummies = (count: number) =>
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const record: Record<string, Tool.AnyTool> = {}
    for (let i = 0; i < count; i++) record[i === 0 ? "mcp_ping" : `dummy_${i}`] = dummy(i)
    yield* tools.register(record, { source: "dynamic" }).pipe(Effect.orDie)
  })

describe("W8c MCP tool_search", () => {
  const many = testEffect(graph(8))
  const few = testEffect(graph(8))
  const custom = testEffect(graph(1))

  many.live("9 dummy MCP tools advertise search_tool/use_tool not dummy_8", () =>
    Effect.gen(function* () {
      yield* registerDummies(9)
      const registry = yield* ToolRegistry.Service
      const names = (yield* toolDefinitions(registry)).map((item) => item.name)
      expect(names).toContain("search_tool")
      expect(names).toContain("use_tool")
      expect(names).not.toContain("dummy_8")
      expect(names).not.toContain("mcp_ping")
    }),
  )

  few.live("2 dummy tools stay advertised without search_tool", () =>
    Effect.gen(function* () {
      yield* registerDummies(2)
      const registry = yield* ToolRegistry.Service
      const names = (yield* toolDefinitions(registry)).map((item) => item.name)
      expect(names).toContain("mcp_ping")
      expect(names).toContain("dummy_1")
      expect(names).not.toContain("search_tool")
      expect(names).not.toContain("use_tool")
    }),
  )

  many.live("search_tool matches description", () =>
    Effect.gen(function* () {
      yield* registerDummies(9)
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-search", name: "search_tool", input: { query: "number 8" } },
      })
      expect(result.type).not.toBe("error")
      const text = JSON.stringify(result)
      expect(text).toContain("dummy_8")
    }),
  )

  many.live("use_tool settles the inner name and hooks see mcp_ping", () =>
    Effect.gen(function* () {
      pingCount = 0
      seen.length = 0
      yield* registerDummies(9)
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-use",
          name: "use_tool",
          input: { name: "mcp_ping", input: {} },
        },
      })
      expect(result.type).not.toBe("error")
      expect(pingCount).toBe(1)
      expect(seen).toContain("mcp_ping")
      expect(seen).not.toContain("use_tool")
    }),
  )

  many.live("use_tool unknown name errors", () =>
    Effect.gen(function* () {
      yield* registerDummies(9)
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-missing",
          name: "use_tool",
          input: { name: "no_such_tool", input: {} },
        },
      })
      expect(result.type).toBe("error")
      expect(String((result as { value: string }).value)).toContain("search_tool")
    }),
  )

  custom.live("mcp.deferAfter 1 hides a second dynamic tool", () =>
    Effect.gen(function* () {
      yield* registerDummies(2)
      const registry = yield* ToolRegistry.Service
      const names = (yield* toolDefinitions(registry)).map((item) => item.name)
      expect(names).toContain("search_tool")
      expect(names).not.toContain("dummy_1")
    }),
  )

  many.live("search_tool ranks name tokens above description and returns nothing on no match", () =>
    Effect.gen(function* () {
      yield* registerDummies(9)
      const registry = yield* ToolRegistry.Service
      const ranked = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-rank", name: "search_tool", input: { query: "ping" } },
      })
      expect(ranked.type).not.toBe("error")
      const rankedText = JSON.stringify(ranked)
      expect(rankedText).toContain("mcp_ping")
      const pingAt = rankedText.indexOf("mcp_ping")
      const dummyAt = rankedText.indexOf("dummy_")
      if (dummyAt >= 0) expect(pingAt).toBeLessThan(dummyAt)

      const missed = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-miss", name: "search_tool", input: { query: "no-such-deferred-tool" } },
      })
      expect(missed.type).not.toBe("error")
      expect(JSON.stringify(missed)).not.toContain("dummy_")
      expect(JSON.stringify(missed)).not.toContain("mcp_ping")
    }),
  )
})
