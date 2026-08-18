export * as Config from "./config"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { type ParseError, parse } from "jsonc-parser"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Permission } from "@opencode-ai/schema/permission"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { Policy } from "./policy"
import { AbsolutePath } from "./schema"
import { ConfigAgent } from "./config/agent"
import { ConfigAttachments } from "./config/attachments"
import { ConfigCompaction } from "./config/compaction"
import { ConfigCommand } from "./config/command"
import { ConfigExperimental } from "./config/experimental"
import { ConfigFormatter } from "./config/formatter"
import { ConfigLSP } from "./config/lsp"
import { ConfigMCP } from "./config/mcp"
import { ConfigPlugin } from "./config/plugin"
import { ConfigProvider } from "./config/provider"
import { ConfigReference } from "./config/reference"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigWatcher } from "./config/watcher"
import { ConfigV1 } from "./config/legacy/config"
import { ConfigMigrateV1 } from "./config/legacy/migrate"
import { Flag } from "./flag/flag"
import { substitute } from "./config/variable"

export { substitute } from "./config/variable"

export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  default_agent: Schema.String.pipe(Schema.optional).annotate({
    description: "Default primary agent to use when no session agent is selected",
  }),
  autoupdate: Schema.Union([Schema.Boolean, Schema.Literal("notify")])
    .pipe(Schema.optional)
    .annotate({
      description: "Automatically update or notify when a new version is available",
    }),
  share: Schema.Literals(["manual", "auto", "disabled"]).pipe(Schema.optional).annotate({
    description: "Control whether sessions may be shared manually, automatically, or not at all",
  }),
  enterprise: Schema.Struct({
    url: Schema.String.pipe(Schema.optional),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Enterprise sharing service configuration",
    }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: "Username displayed in conversations and used for telemetry identity",
  }),
  permissions: Permission.Ruleset.pipe(Schema.optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(Schema.optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  snapshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable snapshots used for undo and revert behavior",
  }),
  watcher: ConfigWatcher.Info.pipe(Schema.optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  formatter: ConfigFormatter.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in formatters or configure formatter overrides",
  }),
  lsp: ConfigLSP.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in language servers or configure server overrides",
  }),
  attachments: ConfigAttachments.Info.pipe(Schema.optional).annotate({
    description: "Attachment processing configuration",
  }),
  tool_output: ConfigToolOutput.Info.pipe(Schema.optional).annotate({
    description: "Tool output truncation thresholds",
  }),
  mcp: ConfigMCP.Info.pipe(Schema.optional).annotate({
    description: "MCP server configuration",
  }),
  browser: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.optional).annotate({
      description: "Advertise browser_* tools when a Browser.Host is present",
    }),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Minimal browser tool configuration. Default off.",
    }),
  tools: Schema.Struct({
    execute: Schema.Boolean.pipe(Schema.optional).annotate({
      description: "Advertise the CodeMode execute tool. Default true.",
    }),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Built-in tool advertisement overrides",
    }),
  compaction: ConfigCompaction.Info.pipe(Schema.optional).annotate({
    description: "Conversation compaction behavior",
  }),
  skills: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs to discover skills from",
  }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(Schema.optional).annotate({
    description: "Named slash command definitions",
  }),
  instructions: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs supplying ambient instructions",
  }),
  references: ConfigReference.Info.pipe(Schema.optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  plugins: ConfigPlugin.Plugins.pipe(Schema.optional).annotate({
    description: "Ordered external plugin packages to load",
  }),
  experimental: ConfigExperimental.Experimental.pipe(Schema.optional),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
  sandbox: Schema.Struct({
    profile: Schema.String,
  })
    .pipe(Schema.optional)
    .annotate({
      description: "OS sandbox profile for new sessions (off, workspace, read-only, strict, or a custom name)",
    }),
}) {}

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: Schema.String.pipe(Schema.optional),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export type Entry = Document | Directory

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)?.info[key]
}

export interface Interface {
  /** Returns location config documents and supplemental directories from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
  /** Re-walk the location and reload documents. Use after writing `opencode.json` without reopening. */
  readonly reload: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Config") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service
    const names = ["opencode.json", "opencode.jsonc"]
    const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
    const decodeInfo = Schema.decodeUnknownOption(Info, decodeOptions)
    const decodeV1Info = Schema.decodeUnknownOption(ConfigV1.Info, decodeOptions)

    const parseDocument = (text: string, source?: string) => {
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return
      const info = Option.getOrUndefined(
        ConfigMigrateV1.isV1(input)
          ? decodeV1Info(input).pipe(Option.map(ConfigMigrateV1.migrate), Option.flatMap(decodeInfo))
          : decodeInfo(input),
      )
      if (!info) return
      return new Document({ type: "document", ...(source === undefined ? {} : { path: source }), info })
    }

    const expand = (text: string, origin: { path: string } | { source: string; dir: string }) =>
      Effect.tryPromise({
        try: () =>
          substitute(
            "path" in origin
              ? { text, type: "path", path: origin.path }
              : { text, type: "virtual", source: origin.source, dir: origin.dir },
          ),
        catch: (error) => error,
      }).pipe(Effect.orDie)

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return
      const expanded = yield* expand(text, { path: filepath })
      return parseDocument(expanded, filepath)
    })

    const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
      return [
        ...(yield* Effect.forEach(names, (file) => loadFile(path.join(directory, file))).pipe(
          Effect.map((configs) => configs.filter((config): config is Document => config !== undefined)),
        )),
        new Directory({ type: "directory", path: directory }),
      ]
    })

    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)

    const load = Effect.fn("Config.load")(function* () {
      // Re-walk on every load so a newly written opencode.json is visible
      // without reopening the location (test harness + config reload).
      // OPENCODE_DISABLE_PROJECT_CONFIG matches leftover: skip repo opencode.json
      // / .opencode walks, keep global + env overrides.
      const discovered =
        locationIsGlobal || Flag.OPENCODE_DISABLE_PROJECT_CONFIG
          ? []
          : yield* fs
              .up({
                targets: [".opencode", ...names.toReversed()],
                start: location.directory,
                stop: location.project.directory,
              })
              .pipe(Effect.orDie)
      const directories = [
        globalDirectory,
        ...discovered
          .filter((item) => path.basename(item) === ".opencode")
          .toReversed()
          .map((directory) => AbsolutePath.make(directory)),
      ]
      // A config closer to the opened directory should win over one higher up.
      // Search starts nearby, so reverse the results before applying them.
      const directPaths = discovered.filter((item) => path.basename(item) !== ".opencode").toReversed()
      const direct = yield* Effect.forEach(directPaths, loadFile).pipe(
        Effect.orDie,
        Effect.map((items) => items.filter((config): config is Document => config !== undefined)),
      )
      const supplementary = yield* Effect.forEach(directories, loadDirectory).pipe(Effect.orDie)
      const configFile = process.env.OPENCODE_CONFIG ? yield* loadFile(process.env.OPENCODE_CONFIG) : undefined
      const configDir = Flag.OPENCODE_CONFIG_DIR
        ? yield* loadDirectory(AbsolutePath.make(path.resolve(Flag.OPENCODE_CONFIG_DIR)))
        : []
      // Leftover Config applies OPENCODE_CONFIG_CONTENT after project files so it
      // is the runtime override the CLI / JS SDK actually ship (test providers,
      // `createOpencode({ config })`). Live catalog reads this Config.Service.
      const configContent = process.env.OPENCODE_CONFIG_CONTENT
        ? yield* expand(process.env.OPENCODE_CONFIG_CONTENT, {
            source: "OPENCODE_CONFIG_CONTENT",
            dir: location.directory,
          }).pipe(Effect.map((text) => parseDocument(text, "OPENCODE_CONFIG_CONTENT")))
        : undefined
      // Apply general settings first and more specific settings last:
      // global config, OPENCODE_CONFIG, project files, `.opencode` / CONFIG_DIR,
      // then OPENCODE_CONFIG_CONTENT.
      const loaded = [
        ...(supplementary[0] ?? []),
        ...(configFile ? [configFile] : []),
        ...direct,
        ...supplementary.slice(1).flat(),
        ...configDir,
        ...(configContent ? [configContent] : []),
      ]
      // Rules use the opposite order so a user-global rule can override a
      // repository rule. Statement order inside each file stays unchanged.
      yield* policy.load(
        loaded
          .filter((entry): entry is Document => entry.type === "document")
          .toReversed()
          .flatMap((entry) => entry.info.experimental?.policies ?? []),
      )
      return loaded
    })

    let configs = yield* load()

    return Service.of({
      entries: Effect.fn("Config.entries")(function* () {
        return configs
      }),
      reload: Effect.fn("Config.reload")(function* () {
        configs = yield* load()
      }),
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node],
})
