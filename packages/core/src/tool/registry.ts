export * as ToolRegistry from "./registry"

import { ToolOutput, ToolDefinition, type ToolCall, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Option, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { definition, permission, settle, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
}

export interface Interface {
  readonly materialize: (agent?: {
    permissions?: PermissionV2.Ruleset
    capability?: "read-only" | "read-write" | "execute" | "all"
  }) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (input: ExecuteInput, advertised?: object) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ?? applications.entries().get(input.call.name)
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (agent = {}) {
        const permissions = agent.permissions ?? []
        const registrations = new Map(applications.entries())
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)
        if (agent.capability !== undefined) {
          for (const name of Array.from(registrations.keys())) {
            if (!capabilityAllows(name, agent.capability)) registrations.delete(name)
          }
        }
        const definitions = Array.from(registrations, ([name, registration]) => definition(name, registration.tool))
        // Restore V1 describeTask: append callable subagent catalog to task tool description.
        if (registrations.has("task")) {
          const appendix = yield* describeTaskAgents(permissions)
          if (appendix) {
            const idx = definitions.findIndex((item) => item.name === "task")
            if (idx >= 0) {
              const base = definitions[idx]!
              definitions[idx] = new ToolDefinition({
                name: base.name,
                description: `${base.description}\n\n${appendix}`,
                inputSchema: base.inputSchema,
                outputSchema: base.outputSchema,
                cache: base.cache,
                metadata: base.metadata,
                native: base.native,
              })
            }
          }
        }
        return {
          definitions,
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            return Effect.succeed({ result: { type: "error", value: `Unknown tool: ${input.call.name}` } })
          },
        }
      }),
    })
  }),
)

/**
 * Parent-facing subagent catalog (V1 describeTask port).
 * Filters: not primary, not hidden, parent may call task on that agent id.
 * Capability tag included when set (Tier 2).
 */
const describeTaskAgents = Effect.fn("ToolRegistry.describeTaskAgents")(function* (
  parentPermissions: PermissionV2.Ruleset,
) {
  const agentsOpt = yield* Effect.serviceOption(AgentV2.Service)
  if (Option.isNone(agentsOpt)) return undefined
  const items = (yield* agentsOpt.value.all())
    .filter((item) => item.mode !== "primary" && !item.hidden)
    .filter((item) => PermissionV2.evaluate("task", String(item.id), parentPermissions).effect !== "deny")
    .toSorted((a, b) => String(a.id).localeCompare(String(b.id)))
  if (items.length === 0) return undefined
  const lines = items.map((item) => {
    const tag = item.capability ? ` [${item.capability}]` : ""
    const blurb = item.description ?? "This subagent should only be called manually by the user."
    return `- ${item.id}${tag}: ${blurb}`
  })
  return ["Available agent types and the tools they have access to:", ...lines].join("\n")
})

const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

/**
 * Capability filter (orthogonal to permission rules): which tool names are
 * allowed for each capability mode. read-only agents get no write paths and no
 * shell; read-write adds edit/write/apply_patch but keeps bash off; execute
 * allows bash but no file mutation.
 */
function capabilityAllows(toolName: string, capability: "read-only" | "read-write" | "execute" | "all"): boolean {
  if (capability === "all") return true
  const WRITE_TOOLS = new Set(["edit", "write", "apply_patch", "bash", "memory_add_note"])
  if (capability === "read-only") {
    if (WRITE_TOOLS.has(toolName)) return false
    return true
  }
  if (capability === "read-write") {
    if (toolName === "bash") return false
    return true
  }
  // execute: bash allowed, file mutation denied
  if (capability === "execute") {
    if (toolName === "edit" || toolName === "write" || toolName === "apply_patch" || toolName === "memory_add_note") return false
    return true
  }
  return true
}

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ToolOutputStore.node],
})
