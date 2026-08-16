/**
 * Registers MCP + plugin tools into core Location Tools.Service so V2
 * SessionRunner.materialize() advertises and settles them.
 */
export * as DynamicTools from "./dynamic-tools"

import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { ToolFailure } from "@opencode-ai/llm"
import { DynamicTools } from "@opencode-ai/core/tool/dynamic"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Tools } from "@opencode-ai/core/tool/tools"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Location } from "@opencode-ai/core/location"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import type { ToolDefinition } from "@opencode-ai/plugin"
import { Effect, Exit, JsonSchema, Layer, Option, Schema, Scope, Stream } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { MCP, type McpTool } from "@/mcp"
import { Plugin } from "@/plugin"
import { InstanceStore } from "@/project/instance-store"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EffectBridge } from "@/effect/bridge"
import path from "path"
import { pathToFileURL } from "url"
import { Glob } from "@opencode-ai/core/util/glob"
import { Config } from "@/config/config"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import z from "zod"

function renderMcpInstructions(items: MCP.ServerInstructions[]) {
  const instructions = items.filter((item) => item.instructions.trim().length > 0)
  if (instructions.length === 0) return
  return [
    "<mcp_instructions>",
    ...instructions.flatMap((item) => [
      `  <server name="${item.name}">`,
      ...item.instructions.split("\n").map((line) => `    ${line}`),
      "  </server>",
    ]),
    "</mcp_instructions>",
  ].join("\n")
}

const mcpInstructionsKey = SystemContext.Key.make("mcp/instructions")

const DynamicOutput = Schema.Struct({
  title: Schema.String,
  output: Schema.String,
})

function normalizeJsonSchema(schema: unknown): JSONSchema7 {
  const base = (schema && typeof schema === "object" ? schema : {}) as JSONSchema7
  return {
    ...base,
    type: "object",
    properties: (base.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: base.additionalProperties ?? false,
  }
}

function isPluginTool(value: unknown): value is ToolDefinition {
  if (!value || typeof value !== "object") return false
  const def = value as ToolDefinition
  return typeof def.description === "string" && typeof def.execute === "function"
}

function isZodType(value: unknown): value is z.ZodType {
  return !!value && typeof value === "object" && "_def" in (value as object)
}

function assertPermission(action: string, context: Tool.Context) {
  return Effect.gen(function* () {
    const permission = yield* Effect.serviceOption(PermissionV2.Service)
    if (Option.isNone(permission)) return
    yield* permission.value
      .assert({
        action,
        resources: ["*"],
        save: ["*"],
        sessionID: context.sessionID,
        agent: context.agent,
        source: {
          type: "tool",
          messageID: context.assistantMessageID,
          callID: context.toolCallID,
        },
      })
      .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${action}` })))
  })
}

function mcpToTool(
  name: string,
  entry: McpTool,
): Tool.AnyTool {
  return Tool.make({
    description: entry.def.description ?? "",
    input: Schema.Unknown,
    inputJsonSchema: normalizeJsonSchema(entry.def.inputSchema) as JsonSchema.JsonSchema,
    output: DynamicOutput,
    toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
    execute: (input, context) =>
      Effect.gen(function* () {
        yield* assertPermission(name, context)

        const result = yield* Effect.tryPromise({
          try: () =>
            entry.client.callTool(
              {
                name: entry.def.name,
                arguments: (input ?? {}) as Record<string, unknown>,
              },
              CallToolResultSchema,
              {
                resetTimeoutOnProgress: true,
                timeout: entry.timeout,
                onprogress: () => {},
              },
            ),
          catch: (e) => new ToolFailure({ message: e instanceof Error ? e.message : String(e) }),
        })

        if (result.isError) {
          const message =
            result.content
              .flatMap((item) => (item.type === "text" && item.text ? [item.text] : []))
              .filter((text) => text.trim())
              .join("\n\n") || "MCP tool returned an error"
          return yield* new ToolFailure({ message })
        }

        const textParts: string[] = []
        for (const contentItem of result.content) {
          if (contentItem.type === "text" && contentItem.text) textParts.push(contentItem.text)
        }
        if (textParts.length === 0 && result.structuredContent !== undefined && result.structuredContent !== null) {
          textParts.push(JSON.stringify(result.structuredContent))
        }

        return { title: entry.def.name, output: textParts.join("\n\n") || "(empty MCP result)" }
      }),
  })
}

function pluginToTool(id: string, def: ToolDefinition, directory: string, worktree: string): Tool.AnyTool {
  const args = def.args ?? {}
  const entries = Object.entries(args)
  const allZod = entries.every((entry) => isZodType(entry[1]))
  const zodParams = allZod && entries.length > 0 ? z.object(args as z.ZodRawShape) : undefined
  let inputJsonSchema: JSONSchema7 = { type: "object", properties: {}, additionalProperties: false }
  if (zodParams) {
    try {
      inputJsonSchema = normalizeJsonSchema(z.toJSONSchema(zodParams, { io: "input" }))
    } catch {
      // keep empty object schema
    }
  }

  return Tool.make({
    description: def.description,
    input: Schema.Unknown,
    inputJsonSchema: inputJsonSchema as JsonSchema.JsonSchema,
    output: DynamicOutput,
    toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
    execute: (input, context) =>
      Effect.gen(function* () {
        yield* assertPermission(id, context)

        let parsedInput = input
        if (zodParams) {
          const parsed = zodParams.safeParse(input)
          if (!parsed.success) {
            return yield* new ToolFailure({ message: `Invalid tool input: ${parsed.error.message}` })
          }
          parsedInput = parsed.data
        }

        const bridge = yield* EffectBridge.make()
        const permission = yield* Effect.serviceOption(PermissionV2.Service)
        const pluginCtx = {
          sessionID: String(context.sessionID),
          messageID: String(context.assistantMessageID),
          agent: String(context.agent),
          abort: new AbortController().signal,
          directory,
          worktree,
          metadata: async () => {},
          ask: (req: {
            permission: string
            patterns?: string[]
            always?: string[]
            metadata?: Record<string, unknown>
          }) =>
            bridge.promise(
              Option.isNone(permission)
                ? Effect.void
                : permission.value
                    .assert({
                      action: req.permission,
                      resources: req.patterns ?? ["*"],
                      save: req.always ?? ["*"],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: {
                        type: "tool",
                        messageID: context.assistantMessageID,
                        callID: context.toolCallID,
                      },
                      metadata: req.metadata,
                    })
                    .pipe(Effect.asVoid),
            ),
        }

        const result = yield* Effect.tryPromise({
          try: () => def.execute(parsedInput as Parameters<typeof def.execute>[0], pluginCtx as Parameters<typeof def.execute>[1]),
          catch: (e) => new ToolFailure({ message: e instanceof Error ? e.message : String(e) }),
        })

        if (typeof result === "string") {
          return { title: id, output: result }
        }
        return {
          title: result.title ?? id,
          output: result.output,
        }
      }),
  })
}

const hostLayer = Layer.effect(
  DynamicTools.HostService,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const plugin = yield* Plugin.Service
    const instances = yield* InstanceStore.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service

    return DynamicTools.HostService.of({
      install: Effect.gen(function* () {
        const tools = yield* Tools.Service
        const registry = yield* SystemContextRegistry.Service
        const location = yield* Effect.serviceOption(Location.Service)
        const directory = Option.isSome(location) ? String(location.value.directory) : process.cwd()
        const worktree =
          Option.isSome(location) && location.value.project?.directory
            ? String(location.value.project.directory)
            : directory

        yield* registry.register({
          key: mcpInstructionsKey,
          load: Effect.gen(function* () {
            const items = yield* instances.provide({ directory }, mcp.instructions()).pipe(
              Effect.catchCause(() => Effect.succeed([] as MCP.ServerInstructions[])),
            )
            const text = renderMcpInstructions(items)
            if (!text) return SystemContext.empty
            return SystemContext.make({
              key: mcpInstructionsKey,
              codec: Schema.toCodecJson(Schema.String),
              load: Effect.succeed(text),
              baseline: (value) => value,
              update: (_previous, value) => value,
              removed: () => "MCP server instructions no longer apply.",
            })
          }),
        })

        let registrationScope: Scope.Scope | undefined

        const sync = Effect.fn("DynamicTools.sync")(function* () {
          if (registrationScope) {
            yield* Scope.close(registrationScope, Exit.void).pipe(Effect.ignore)
            registrationScope = undefined
          }

          const scope = yield* Scope.make()
          registrationScope = scope

          const record: Record<string, Tool.AnyTool> = {}

          const mcpTools = yield* instances.provide({ directory }, mcp.tools()).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DynamicTools: MCP tools unavailable", { cause }).pipe(
                Effect.as({} as Record<string, never>),
              ),
            ),
          )

          for (const [name, entry] of Object.entries(mcpTools)) {
            if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) continue
            record[name] = mcpToTool(name, entry)
          }

          const plugins = yield* instances.provide({ directory }, plugin.list()).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DynamicTools: plugins unavailable", { cause }).pipe(Effect.as([])),
            ),
          )

          for (const p of plugins) {
            for (const [id, def] of Object.entries(p.tool ?? {})) {
              if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) continue
              record[id] = pluginToTool(id, def, directory, worktree)
            }
          }

          const dirs = yield* instances
            .provide({ directory }, config.directories())
            .pipe(Effect.catchCause(() => Effect.succeed([] as string[])))

          for (const dir of dirs) {
            const matches = Glob.scanSync("{tool,tools}/*.{js,ts}", {
              cwd: dir,
              absolute: true,
              dot: true,
              symlink: true,
            })
            for (const match of matches) {
              const namespace = path.basename(match, path.extname(match))
              const mod = yield* Effect.tryPromise({
                try: () => import(pathToFileURL(match).href),
                catch: () => undefined,
              }).pipe(Effect.catch(() => Effect.succeed(undefined as Record<string, unknown> | undefined)))
              if (!mod) continue
              for (const [exportId, def] of Object.entries(mod)) {
                if (!isPluginTool(def)) continue
                const id = exportId === "default" ? namespace : `${namespace}_${exportId}`
                if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) continue
                record[id] = pluginToTool(id, def, directory, worktree)
              }
            }
          }

          if (Object.keys(record).length === 0) return

          yield* tools.register(record, { source: "dynamic" }).pipe(Scope.provide(scope), Effect.orDie)
          yield* Effect.logInfo("DynamicTools registered", {
            directory,
            count: Object.keys(record).length,
          })
        })

        yield* sync()

        yield* events.subscribe(MCP.ToolsChanged).pipe(
          Stream.runForEach(() => sync().pipe(Effect.ignore)),
          Effect.forkScoped,
        )

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            if (registrationScope) {
              yield* Scope.close(registrationScope, Exit.void).pipe(Effect.ignore)
              registrationScope = undefined
            }
          }),
        )
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: DynamicTools.HostService,
  layer: hostLayer,
  deps: [MCP.node, Plugin.node, InstanceStore.node, Config.node, EventV2Bridge.node],
})
