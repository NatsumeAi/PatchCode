import { EOL } from "os"
import { basename } from "path"
import { Effect } from "effect"
import { Agent as CoreAgent } from "@opencode-ai/core/agent"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Session } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolRegistry as CoreToolRegistry } from "@opencode-ai/core/tool/registry"
import { Agent } from "../../../agent/agent"
import { Permission } from "../../../permission"
import { iife } from "../../../util/iife"
import { fail } from "../../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"

export const debugAgent = Effect.fn("Cli.debug.agent")(function* (args: {
  name: string
  tool?: string
  params?: string
}) {
  const ctx = yield* InstanceRef
  if (!ctx) return
  return yield* run(args, ctx)
})

const run = Effect.fn("Cli.debug.agent.body")(function* (
  args: { name: string; tool?: string; params?: string },
  ctx: InstanceContext,
) {
  const agentName = args.name
  const agent = yield* Agent.Service.use((svc) => svc.get(agentName))
  if (!agent) {
    process.stderr.write(
      `Agent ${agentName} not found, run '${basename(process.execPath)} agent list' to get an agent list` + EOL,
    )
    return yield* fail("", 1)
  }
  const availableTools = yield* getAvailableTools(ctx)
  const resolvedTools = resolveTools(agent, availableTools)
  const toolID = args.tool
  if (toolID) {
    const tool = availableTools.find((item) => item.id === toolID)
    if (!tool) {
      process.stderr.write(`Tool ${toolID} not found for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    if (resolvedTools[toolID] === false) {
      process.stderr.write(`Tool ${toolID} is disabled for agent ${agentName}` + EOL)
      return yield* fail("", 1)
    }
    const params = parseToolParams(args.params)
    const result = yield* executeTool(agent, ctx, toolID, params)
    process.stdout.write(JSON.stringify({ tool: toolID, input: params, result }, null, 2) + EOL)
    return
  }

  const output = {
    ...agent,
    tools: resolvedTools,
  }
  process.stdout.write(JSON.stringify(output, null, 2) + EOL)
})

const withLocationTools = <A, E, R>(ctx: InstanceContext, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const directory = AbsolutePath.make(ctx.directory)
    return yield* effect.pipe(Effect.provide(locations.get(Location.Ref.make({ directory }))))
  })

const getAvailableTools = Effect.fn("Cli.debug.agent.getAvailableTools")(function* (ctx: InstanceContext) {
  return yield* withLocationTools(
    ctx,
    Effect.gen(function* () {
      const registry = yield* CoreToolRegistry.Service
      const materialized = yield* registry.materialize()
      return materialized.definitions.map((item) => ({ id: item.name }))
    }),
  )
})

function resolveTools(agent: Agent.Info, availableTools: { id: string }[]) {
  const disabled = Permission.disabled(
    availableTools.map((tool) => tool.id),
    agent.permission,
  )
  const resolved: Record<string, boolean> = {}
  for (const tool of availableTools) {
    resolved[tool.id] = !disabled.has(tool.id)
  }
  return resolved
}

function parseToolParams(input?: string) {
  if (!input) return {}
  const trimmed = input.trim()
  if (trimmed.length === 0) return {}

  const parsed = iife(() => {
    try {
      return JSON.parse(trimmed)
    } catch (jsonError) {
      try {
        return new Function(`return (${trimmed})`)()
      } catch (evalError) {
        throw new Error(
          `Failed to parse --params. Use JSON or a JS object literal. JSON error: ${jsonError}. Eval error: ${evalError}.`,
          { cause: evalError },
        )
      }
    }
  })

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool params must be an object.")
  }
  return parsed as Record<string, unknown>
}

const executeTool = Effect.fn("Cli.debug.agent.executeTool")(function* (
  agent: Agent.Info,
  ctx: InstanceContext,
  toolID: string,
  params: Record<string, unknown>,
) {
  const v2 = yield* Session.Service
  const session = yield* v2.create({
    title: `Debug tool run (${agent.name})`,
    location: Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }),
  })
  return yield* withLocationTools(
    ctx,
    Effect.gen(function* () {
      const registry = yield* CoreToolRegistry.Service
      const materialized = yield* registry.materialize()
      const settlement = yield* materialized.settle({
        sessionID: session.id,
        agent: CoreAgent.ID.make(agent.name),
        assistantMessageID: SessionMessage.ID.create(),
        call: {
          type: "tool-call",
          id: `debug_${toolID}`,
          name: toolID,
          input: params,
        },
      })
      return settlement.result
    }),
  )
})
