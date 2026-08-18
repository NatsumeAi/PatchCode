/**
 * Registers MCP + plugin tools into core Location Tools.Service so
 * SessionRunner.materialize() advertises and settles them.
 */
export * as DynamicTools from "./dynamic-tools"

import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { ToolFailure } from "@opencode-ai/llm"
import { DynamicTools } from "@opencode-ai/core/tool/dynamic"
import { Tool } from "@opencode-ai/core/tool/tool"
import { Tools } from "@opencode-ai/core/tool/tools"
import { Permission } from "@opencode-ai/core/permission"
import { Location } from "@opencode-ai/core/location"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Hooks } from "@opencode-ai/core/hooks"
import type { ToolDefinition, Hooks as PluginHooks } from "@opencode-ai/plugin"
import { Effect, Exit, JsonSchema, Layer, Option, Schema, Scope, Stream } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { MCP, type McpTool } from "@/mcp"
import { Plugin } from "@/plugin"
import { inProcessFromPlugin } from "@/plugin/hooks-bridge"
import { InstanceStore } from "@/project/instance-store"
import { EventBridge } from "@/event-bridge"
import { EffectBridge } from "@/effect/bridge"
import path from "path"
import { pathToFileURL } from "url"
import { Glob } from "@opencode-ai/core/util/glob"
import { Config } from "@/config/config"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import z from "zod"
import { ZodMetadata } from "@opencode-ai/core/tool/zod-metadata"

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
  attachments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        mime: Schema.String,
        data: Schema.String,
        name: Schema.optional(Schema.String),
      }),
    ),
  ),
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
  return typeof value === "object" && value !== null && ("_zod" in value || "_def" in value)
}

function assertPermission(action: string, context: Tool.Context, extra?: { resources?: string[]; save?: string[] }) {
  return Effect.gen(function* () {
    const permission = yield* Effect.serviceOption(Permission.Service)
    if (Option.isNone(permission)) {
      return yield* new ToolFailure({ message: `Permission denied: ${action}` })
    }
    yield* permission.value
      .assert({
        action,
        resources: extra?.resources ?? ["*"],
        save: extra?.save ?? ["*"],
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

const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
export const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

const ListMcpResourcesInput = Schema.Struct({
  server: Schema.optional(Schema.String),
})
const ReadMcpResourceInput = Schema.Struct({
  server: Schema.String,
  uri: Schema.String,
})

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = optionalString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

function formatMcpResource(resource: { client: string } & Record<string, unknown>) {
  const result = Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "client"))
  return { ...result, server: resource.client }
}

export function formatMcpResourceContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Array<{ mime: string; data: string; name: string }> = []

  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      const size = base64Size(item.blob)
      if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({ mime, data: item.blob, name: itemUri })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }

  return {
    attachments,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function resourceServers(clients: Record<string, { getServerCapabilities?: () => { resources?: unknown } | undefined }>) {
  return Object.entries(clients)
    .filter((entry) => !!entry[1].getServerCapabilities?.()?.resources)
    .map((entry) => entry[0])
    .sort((a, b) => a.localeCompare(b))
}

function mcpResourceTools(mcp: MCP.Interface): Record<string, Tool.AnyTool> {
  const list = Tool.withPermission(
    Tool.make({
      description:
        "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
      input: ListMcpResourcesInput,
      output: DynamicOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
      execute: (input, context) =>
        Effect.gen(function* () {
          const parsed = { server: optionalString(toRecord(input), "server") }
          const clients = yield* mcp.clients()
          const servers = resourceServers(clients)
          if (parsed.server && !servers.includes(parsed.server)) {
            return yield* new ToolFailure({
              message:
                servers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${servers.join(", ")}`,
            })
          }
          const patterns = parsed.server ? [`mcp:${parsed.server}:*`] : servers.map((server) => `mcp:${server}:*`)
          yield* assertPermission("read", context, { resources: patterns, save: patterns })
          const resources = Object.values(yield* mcp.resources(parsed.server))
          const filtered = resources
            .filter((resource) => !parsed.server || resource.client === parsed.server)
            .toSorted((a, b) =>
              (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
                b.client + "\u0000" + b.name + "\u0000" + b.uri,
              ),
            )
          return {
            title: parsed.server ? `MCP resources: ${parsed.server}` : "MCP resources",
            output: JSON.stringify({ resources: filtered.map((item) => formatMcpResource(item)) }, null, 2),
          }
        }),
    }),
    "read",
  )

  const listTemplates = Tool.withPermission(
    Tool.make({
      description:
        "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
      input: ListMcpResourcesInput,
      output: DynamicOutput,
      toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
      execute: (input, context) =>
        Effect.gen(function* () {
          const parsed = { server: optionalString(toRecord(input), "server") }
          const clients = yield* mcp.clients()
          const servers = resourceServers(clients)
          if (parsed.server && !servers.includes(parsed.server)) {
            return yield* new ToolFailure({
              message:
                servers.length === 0
                  ? `MCP server "${parsed.server}" does not support resources`
                  : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${servers.join(", ")}`,
            })
          }
          const patterns = parsed.server ? [`mcp:${parsed.server}:*`] : servers.map((server) => `mcp:${server}:*`)
          yield* assertPermission("read", context, { resources: patterns, save: patterns })
          const templates = Object.values(yield* mcp.resourceTemplates(parsed.server))
          const filtered = templates
            .filter((template) => !parsed.server || template.client === parsed.server)
            .toSorted((a, b) =>
              (a.client + "\u0000" + String(a.name ?? "") + "\u0000" + String(a.uriTemplate ?? "")).localeCompare(
                b.client + "\u0000" + String(b.name ?? "") + "\u0000" + String(b.uriTemplate ?? ""),
              ),
            )
          return {
            title: parsed.server ? `MCP resource templates: ${parsed.server}` : "MCP resource templates",
            output: JSON.stringify(
              { resourceTemplates: filtered.map((item) => formatMcpResource(item as { client: string } & Record<string, unknown>)) },
              null,
              2,
            ),
          }
        }),
    }),
    "read",
  )

  const read = Tool.withPermission(
    Tool.make({
      description:
        "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
      input: ReadMcpResourceInput,
      output: DynamicOutput,
      toModelOutput: ({ output }) => [
        { type: "text", text: output.output },
        ...(output.attachments ?? []).map((item) => ({
          type: "file" as const,
          data: item.data,
          mime: item.mime,
          name: item.name ?? output.title,
        })),
      ],
      execute: (input, context) =>
        Effect.gen(function* () {
          const parsed = {
            server: requiredString(toRecord(input), "server"),
            uri: requiredString(toRecord(input), "uri"),
          }
          const clients = yield* mcp.clients()
          const client = clients[parsed.server]
          if (!client) return yield* new ToolFailure({ message: `MCP server "${parsed.server}" is not connected` })
          if (!client.getServerCapabilities()?.resources) {
            return yield* new ToolFailure({ message: `MCP server "${parsed.server}" does not support resources` })
          }
          yield* assertPermission("read", context, {
            resources: [`mcp:${parsed.server}:${parsed.uri}`],
            save: [`mcp:${parsed.server}:*`],
          })
          const content = yield* mcp.readResource(parsed.server, parsed.uri)
          if (!content) {
            return yield* new ToolFailure({ message: `Failed to read MCP resource: ${parsed.server}/${parsed.uri}` })
          }
          const formatted = formatMcpResourceContent(parsed.server, parsed.uri, content)
          return {
            title: `MCP resource: ${parsed.uri}`,
            output: formatted.text,
            ...(formatted.attachments.length > 0 ? { attachments: formatted.attachments } : {}),
          }
        }),
    }),
    "read",
  )

  return {
    [MCP_RESOURCE_TOOLS.list]: list,
    [MCP_RESOURCE_TOOLS.listTemplates]: listTemplates,
    [MCP_RESOURCE_TOOLS.read]: read,
  }
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
      inputJsonSchema = normalizeJsonSchema(ZodMetadata.toJsonSchema(zodParams) as JSONSchema7)
    } catch {
      // keep empty object schema
    }
  }

  return Tool.make({
    description: def.description,
    input: Schema.Unknown,
    inputJsonSchema: inputJsonSchema as JsonSchema.JsonSchema,
    output: DynamicOutput,
    toModelOutput: ({ output }) => [
      { type: "text", text: output.output },
      ...(output.attachments ?? []).map((item) => ({
        type: "file" as const,
        data: item.data,
        mime: item.mime,
        name: item.name ?? id,
      })),
    ],
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
        const permission = yield* Effect.serviceOption(Permission.Service)
        const pluginCtx = {
          sessionID: String(context.sessionID),
          messageID: String(context.assistantMessageID),
          agent: String(context.agent),
          abort: new AbortController().signal,
          directory,
          worktree,
          metadata: async () => {},
          ask: (req: {
            action: string
            resources?: string[]
            save?: string[]
            metadata?: Record<string, unknown>
          }) =>
            bridge.promise(
              Option.isNone(permission)
                ? Effect.fail(new ToolFailure({ message: `Permission denied: ${req.action}` }))
                : permission.value
                    .assert({
                      action: req.action,
                      resources: req.resources ?? ["*"],
                      save: req.save ?? ["*"],
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
        const attachments = result.attachments
          ?.map((item) => {
            if (!item || typeof item !== "object") return undefined
            const mime = "mime" in item && typeof item.mime === "string" ? item.mime : undefined
            const url = "url" in item && typeof item.url === "string" ? item.url : undefined
            if (!mime || !url) return undefined
            const comma = url.indexOf(",")
            const data = url.startsWith("data:") && comma >= 0 ? url.slice(comma + 1) : url
            return { mime, data, name: id }
          })
          .filter((item): item is { mime: string; data: string; name: string } => item !== undefined)
        return {
          title: result.title ?? id,
          output: result.output,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
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
    const events = yield* EventBridge.Service

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

        const hooksSvc = yield* Effect.serviceOption(Hooks.Service)
        if (Option.isSome(hooksSvc)) {
          const plugins = yield* instances.provide({ directory }, plugin.list()).pipe(
            Effect.catchCause(() => Effect.succeed([] as PluginHooks[])),
          )
          for (const [index, item] of plugins.entries()) {
            for (const handler of inProcessFromPlugin(item, index)) {
              yield* hooksSvc.value.register(handler)
            }
          }
        }

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

          const clients = yield* instances.provide({ directory }, mcp.clients()).pipe(
            Effect.catchCause(() => Effect.succeed({} as Record<string, never>)),
          )
          const hasMcpResourceServer = resourceServers(clients).length > 0
          const resourceRecord = hasMcpResourceServer ? mcpResourceTools(mcp) : {}

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
            if (matches.length) yield* config.waitForDependencies()
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

          if (Object.keys(record).length > 0) {
            yield* tools.register(record, { source: "dynamic" }).pipe(Scope.provide(scope), Effect.orDie)
          }
          if (Object.keys(resourceRecord).length > 0) {
            yield* tools.register(resourceRecord, { source: "builtin" }).pipe(Scope.provide(scope), Effect.orDie)
          }
          if (Object.keys(record).length === 0 && Object.keys(resourceRecord).length === 0) return

          yield* Effect.logInfo("DynamicTools registered", {
            directory,
            count: Object.keys(record).length + Object.keys(resourceRecord).length,
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
  deps: [MCP.node, Plugin.node, InstanceStore.node, Config.node, EventBridge.node],
})
