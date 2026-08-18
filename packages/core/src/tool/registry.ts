export * as ToolRegistry from "./registry"

import { ToolOutput, ToolDefinition, type ToolCall, type ToolResultValue } from "@opencode-ai/llm"
import { Context, Effect, Layer, Option, Scope } from "effect"
import { AgentV2 } from "../agent"
import { Permission } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Config } from "../config"
import { ApplicationTools } from "./application-tools"
import { BrowserHost } from "./browser-host"
import { definition, permission, settle, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"
import { Hooks } from "../hooks"
import { ConfigService as WebSearchConfigService, webSearchEnabled } from "./websearch-config"
import { Flag } from "../flag/flag"
import { redactUnknown } from "../secret-redaction"

export const SEARCH_TOOL = "search_tool"
export const USE_TOOL = "use_tool"
export const EXECUTE_TOOL = "execute"
const BROWSER_TOOLS = new Set(["browser_navigate", "browser_snapshot", "browser_act"])
const DEFER_AFTER_DEFAULT = 8

export type DynamicHit = {
  readonly name: string
  readonly description: string
  readonly server: string
}

const tokenize = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length > 0)

export const scoreDynamicHit = (item: DynamicHit, query: string) => {
  const needles = tokenize(query)
  if (needles.length === 0) return 0
  const nameTokens = tokenize(item.name)
  const descTokens = tokenize(item.description)
  let score = 0
  for (const needle of needles) {
    if (nameTokens.some((token) => token === needle)) score += 3
    else if (nameTokens.some((token) => token.includes(needle) || needle.includes(token))) score += 2
    else if (descTokens.some((token) => token === needle || token.includes(needle) || needle.includes(token)))
      score += 1
  }
  return score
}

export const rankDynamicHits = (items: readonly DynamicHit[], query: string, limit = 10) => {
  const needle = query.trim()
  if (needle.length === 0) return limit <= 0 ? [...items] : items.slice(0, limit)
  const needles = tokenize(needle)
  const ranked = items
    .map((item) => ({ item, score: scoreDynamicHit(item, needle) }))
    .filter((entry) => {
      if (entry.score <= 0) return false
      const nameTokens = tokenize(entry.item.name)
      const descTokens = tokenize(entry.item.description)
      return needles.every(
        (token) =>
          nameTokens.some((part) => part === token || part.includes(token) || token.includes(part)) ||
          descTokens.some((part) => part === token || part.includes(token)),
      )
    })
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .map((entry) => entry.item)
  return limit <= 0 ? ranked : ranked.slice(0, limit)
}

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly call: ToolCall
}

export interface Interface {
  readonly materialize: (agent?: {
    permissions?: Permission.Ruleset
    capability?: "read-only" | "read-write" | "execute" | "all"
    modelID?: string
    providerID?: string
  }) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (
    tools: Readonly<Record<string, AnyTool>>,
    options?: Tools.RegisterOptions,
  ) => Effect.Effect<void, RegistrationError, Scope.Scope>
  readonly searchDynamic: (query: string, limit?: number) => Effect.Effect<ReadonlyArray<DynamicHit>>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
  /** Registered but not advertised (official `invalid` repair target). */
  readonly hidden: ReadonlyArray<string>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolRegistry") {}

/** Optional host: leftover plugins rewrite advertised tool descriptions at materialize time. */
export interface DefinitionHook {
  readonly rewrite: (input: {
    readonly toolID: string
    readonly description: string
    readonly parameters: unknown
  }) => Effect.Effect<{ readonly description: string; readonly parameters: unknown }>
}

export class DefinitionHookService extends Context.Service<DefinitionHookService, DefinitionHook>()(
  "@opencode/v2/ToolDefinitionHook",
) {}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = {
      readonly identity: object
      readonly tool: AnyTool
      readonly source: "builtin" | "dynamic"
    }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const settleWith = Effect.fn("ToolRegistry.settle")(function* (input: ExecuteInput, advertised?: object) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ??
        applications.entries().get(input.call.name) ??
        local.get(input.call.name.toLowerCase())?.at(-1)?.registration ??
        applications.entries().get(input.call.name.toLowerCase())
      if (!registration)
        return {
          result: {
            type: "error" as const,
            value: advertised ? `Stale tool call: ${input.call.name}` : `Unknown tool: ${input.call.name}`,
          },
        }
      if (advertised && registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const hooksOpt = yield* Effect.serviceOption(Hooks.Service)
      if (Option.isSome(hooksOpt)) {
        const gated = yield* hooksOpt.value.ensureSessionStart(input.sessionID)
        if (gated._tag === "Deny")
          return { result: { type: "error" as const, value: "session blocked by SessionStart hook" } }
        if (input.call.name !== "bash" && input.call.name !== USE_TOOL) {
          const decision = yield* hooksOpt.value.dispatch({
            event: "PreToolUse",
            sessionID: input.sessionID,
            toolName: input.call.name,
            toolInput: input.call.input,
          })
          if (decision._tag === "Deny")
            return { result: { type: "error" as const, value: `Hook denied: ${decision.reason}` } }
        }
      }
      // Execute stays interruptible (bash collect / task host Effect.never).
      // bound() and the return value must not be in that restored region:
      // a sticky cancel after execute catches interrupt would otherwise
      // drop Success and leave the tool `running`.
      const settlement = yield* Effect.uninterruptibleMask((restore) =>
        restore(
          settle(registration.tool, input.call, {
            sessionID: input.sessionID,
            agent: input.agent,
            assistantMessageID: input.assistantMessageID,
            toolCallID: input.call.id,
          }).pipe(
            Effect.map((output) => ({ output })),
            Effect.catchTag("LLM.ToolFailure", (failure) =>
              Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
            ),
            Effect.catchTag("Permission.BlockedError", () =>
              Effect.succeed({
                result: {
                  type: "error" as const,
                  value: "The user rejected permission to use this specific tool call.",
                },
              }),
            ),
          ),
        ).pipe(
          // exit/bound must wrap restore(), not sit inside it: fiber interrupt
          // never yields an Exit from restore(effect.exit), so Success+bound()
          // would be dropped and the tool would stay `running`.
          Effect.exit,
          Effect.flatMap((exit) => {
            if (exit._tag === "Failure") return Effect.failCause(exit.cause)
            const pending = exit.value
            if ("result" in pending) return Effect.succeed(pending)
            return resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output: pending.output }).pipe(
              Effect.map((bounded) => {
                const result = redactUnknown(ToolOutput.toResultValue(bounded.output)) as ToolResultValue
                const output = redactUnknown(bounded.output) as typeof bounded.output
                if (result.type === "error")
                  return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
                return bounded.outputPaths.length > 0
                  ? { result, output, outputPaths: bounded.outputPaths }
                  : { result, output }
              }),
            )
          }),
        ),
      )
      if (Option.isSome(hooksOpt)) {
        const failed = "result" in settlement && settlement.result.type === "error"
        yield* hooksOpt.value
          .dispatch({
            event: failed ? "PostToolUseFailure" : "PostToolUse",
            sessionID: input.sessionID,
            toolName: input.call.name,
            toolInput: input.call.input,
          })
          .pipe(Effect.ignore)
      }
      return settlement
    })

    return Service.of({
      searchDynamic: Effect.fn("ToolRegistry.searchDynamic")(function* (query: string, limit = 10) {
        const items: DynamicHit[] = []
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (!registration || registration.source !== "dynamic") continue
          const def = definition(name, registration.tool)
          items.push({
            name,
            description: def.description ?? "",
            server: name.includes("_") ? name.slice(0, name.indexOf("_")) : "mcp",
          })
        }
        const needle = query.trim()
        return rankDynamicHits(items, needle, limit)
      }),
      register: Effect.fn("ToolRegistry.register")(function* (tools, options?: Tools.RegisterOptions) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
        const source = options?.source ?? "builtin"
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool, source } }])
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
        const registrations = new Map<string, Registration>()
        for (const [name, entry] of applications.entries()) {
          registrations.set(name, { ...entry, source: "builtin" })
        }
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        if (agent.capability !== undefined) {
          for (const name of Array.from(registrations.keys())) {
            if (!capabilityAllows(name, agent.capability)) registrations.delete(name)
          }
        }
        const configOpt = yield* Effect.serviceOption(Config.Service)
        const configEntries = Option.isSome(configOpt) ? yield* configOpt.value.entries() : []
        const deferAfter = Config.latest(configEntries, "mcp")?.deferAfter ?? DEFER_AFTER_DEFAULT
        const executeEnabled = Config.latest(configEntries, "tools")?.execute !== false
        const browserEnabled = Config.latest(configEntries, "browser")?.enabled === true
        const browserHost = yield* Effect.serviceOption(BrowserHost.HostService)
        const dynamicCount = [...registrations.values()].filter((item) => item.source === "dynamic").length
        const defer = dynamicCount > deferAfter
        const advertised = new Map(registrations)
        for (const name of Array.from(advertised.keys())) {
          const registration = advertised.get(name)
          if (!registration) continue
          if (name === "invalid") {
            advertised.delete(name)
            continue
          }
          if (name === SEARCH_TOOL || name === USE_TOOL) {
            if (!defer) advertised.delete(name)
            continue
          }
          if (registration.source === "dynamic" && defer) advertised.delete(name)
          if (name === EXECUTE_TOOL && !executeEnabled) advertised.delete(name)
          if (BROWSER_TOOLS.has(name) && (!browserEnabled || Option.isNone(browserHost))) advertised.delete(name)
          if (name === "lsp" && !Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL) advertised.delete(name)
        }
        const modelID = agent.modelID ?? ""
        if (modelID) {
          const usePatch = modelID.includes("gpt-") && !modelID.includes("oss") && !modelID.includes("gpt-4")
          if (usePatch) {
            advertised.delete("edit")
            advertised.delete("write")
          } else {
            advertised.delete("apply_patch")
          }
        }
        if (agent.providerID) {
          const search = yield* Effect.serviceOption(WebSearchConfigService)
          const flags = Option.isSome(search)
            ? { exa: search.value.enableExa, parallel: search.value.enableParallel }
            : {}
          if (!webSearchEnabled(agent.providerID, flags)) advertised.delete("websearch")
        }
        for (const name of Array.from(advertised.keys())) {
          const registration = advertised.get(name)
          if (!registration) continue
          const rule = Permission.evaluate(permission(registration.tool, name), "*", permissions)
          if (rule.effect === "deny" && rule.resource === "*") advertised.delete(name)
        }
        const definitions = Array.from(advertised, ([name, registration]) => definition(name, registration.tool))
        // Restore V1 describeTask: append callable subagent catalog to task tool description.
        if (advertised.has("task")) {
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
        const hook = yield* Effect.serviceOption(DefinitionHookService)
        if (Option.isSome(hook)) {
          for (let i = 0; i < definitions.length; i++) {
            const base = definitions[i]!
            const rewritten = yield* hook.value.rewrite({
              toolID: base.name,
              description: base.description,
              parameters: base.inputSchema,
            })
            if (rewritten.description !== base.description || rewritten.parameters !== base.inputSchema) {
              definitions[i] = new ToolDefinition({
                name: base.name,
                description: rewritten.description,
                inputSchema: rewritten.parameters as typeof base.inputSchema,
                outputSchema: base.outputSchema,
                cache: base.cache,
                metadata: base.metadata,
                native: base.native,
              })
            }
          }
        }
        const hidden = [...registrations.keys()].filter((name) => !advertised.has(name))
        return {
          definitions,
          hidden,
          settle: (input) => {
            const registration =
              registrations.get(input.call.name) ?? registrations.get(input.call.name.toLowerCase())
            if (registration) return settleWith(input, registration.identity)
            const invalid = registrations.get("invalid")
            if (invalid) {
              return settleWith(
                {
                  ...input,
                  call: {
                    ...input.call,
                    name: "invalid",
                    input: { tool: input.call.name, error: `Unknown tool: ${input.call.name}` },
                  },
                },
                invalid.identity,
              )
            }
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
  parentPermissions: Permission.Ruleset,
) {
  const agentsOpt = yield* Effect.serviceOption(AgentV2.Service)
  if (Option.isNone(agentsOpt)) return undefined
  const items = (yield* agentsOpt.value.all())
    .filter((item) => item.mode !== "primary" && !item.hidden)
    .filter((item) => Permission.evaluate("task", String(item.id), parentPermissions).effect !== "deny")
    .toSorted((a, b) => String(a.id).localeCompare(String(b.id)))
  if (items.length === 0) return undefined
  const lines = items.map((item) => {
    const tag = item.capability ? ` [${item.capability}]` : ""
    const persona = (item as { persona?: string }).persona
    const personaTag = persona ? ` (persona:${persona})` : ""
    const blurb = item.description ?? "This subagent should only be called manually by the user."
    // Discovery IO line when agent carries persona-related metadata (inputs/outputs optional on agent).
    const io = (item as { inputs?: string[]; outputs?: string[] })
    const ioLine =
      (io.inputs?.length || io.outputs?.length)
        ? ` | in: ${(io.inputs ?? []).join(",") || "-"} out: ${(io.outputs ?? []).join(",") || "-"}`
        : ""
    return `- ${item.id}${tag}${personaTag}: ${blurb}${ioLine}`
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
  const WRITE_TOOLS = new Set(["edit", "write", "apply_patch", "bash", "memory_add_note", "execute"])
  if (capability === "read-only") {
    if (WRITE_TOOLS.has(toolName)) return false
    return true
  }
  if (capability === "read-write") {
    if (toolName === "bash" || toolName === "execute") return false
    return true
  }
  // execute: bash allowed, file mutation denied
  if (capability === "execute") {
    if (toolName === "edit" || toolName === "write" || toolName === "apply_patch" || toolName === "memory_add_note") return false
    return true
  }
  return true
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
