export * as ConfigAgentPlugin from "./agent"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { ConfigAgent } from "../agent"
import { ConfigMarkdown } from "../markdown"
import { FSUtil } from "../../fs-util"
import { ModelV2 } from "../../model"
import { ConfigAgentV1 } from "../../v1/config/agent"
import { ConfigMigrateV1 } from "../../v1/config/migrate"
import { Global } from "../../global"
import { PermissionV2 } from "../../permission"
import type { LocationMutation } from "../../location-mutation"
import type { ReadTool } from "../../tool/read"
import type { EditTool } from "../../tool/edit"

const legacySources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const decodeLegacyAgent = Schema.decodeUnknownOption(ConfigAgentV1.Info)
const decodeConfig = Schema.decodeUnknownOption(Config.Info)
type PathAction =
  | LocationMutation.ExternalDirectoryAuthorization["action"]
  | typeof ReadTool.name
  | typeof EditTool.name
const pathActions = ["external_directory", "read", "edit"] as const satisfies readonly PathAction[]
const agentKeys = new Set([
  "model",
  "variant",
  "request",
  "system",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "disabled",
  "permissions",
  "extends",
  "capability",
  "workspace",
])

export const Plugin = define({
  id: "config-agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    yield* ctx.agent.transform(
      Effect.fn(function* (draft) {
        const documents = yield* Effect.forEach(yield* config.entries(), (entry) => {
          if (entry.type === "document") return Effect.succeed([entry])
          return Effect.gen(function* () {
            const files = yield* discover(fs, entry.path)
            return yield* Effect.forEach(files, (file) =>
              fs.readFileStringSafe(file.filepath).pipe(
                Effect.map((content) => content && decode(file, content)),
                Effect.catch(() => Effect.succeed(undefined)),
              ),
            ).pipe(
              Effect.map((documents) =>
                documents.filter((document): document is Config.Document => document !== undefined),
              ),
            )
          })
        }).pipe(Effect.map((documents) => documents.flat()))
        const permissions = expandPermissions(
          documents.flatMap((document) => document.info.permissions ?? []),
          global.home,
        )
        const configuredDefault = Config.latest(documents, "default_agent")
        if (configuredDefault !== undefined) draft.default(AgentV2.ID.make(configuredDefault))
        for (const current of draft.list()) {
          draft.update(current.id, (agent) => agent.permissions.push(...permissions))
        }

        const inherited = applyInheritance(documents)
        for (const document of documents) {
          for (const [id, item] of Object.entries(document.info.agents ?? {})) {
            const agentID = AgentV2.ID.make(id)
            if (item.disabled) {
              draft.remove(agentID)
              continue
            }

            const exists = draft.get(agentID) !== undefined
            const inheritedItem = inherited.get(id)
            draft.update(agentID, (agent) => {
              if (!exists) agent.permissions.push(...permissions)
              if (inheritedItem?.model !== undefined && agent.model === undefined) {
                const inherited = ModelV2.parse(inheritedItem.model)
                agent.model = { id: inherited.modelID, providerID: inherited.providerID }
              }
              if (item.model !== undefined) {
                const model = ModelV2.parse(item.model)
                agent.model = { id: model.modelID, providerID: model.providerID, variant: agent.model?.variant }
              }
              if (item.variant !== undefined && agent.model !== undefined) {
                agent.model.variant = ModelV2.VariantID.make(item.variant)
              }
              if (inheritedItem?.request !== undefined) {
                Object.assign(agent.request.headers, inheritedItem.request.headers ?? {})
                Object.assign(agent.request.body, inheritedItem.request.body ?? {})
              }
              if (item.request !== undefined) {
                Object.assign(agent.request.headers, item.request.headers ?? {})
                Object.assign(agent.request.body, item.request.body ?? {})
              }
              if (inheritedItem?.system !== undefined && agent.system === undefined) agent.system = inheritedItem.system
              if (item.system !== undefined) agent.system = item.system
              if (inheritedItem?.description !== undefined && agent.description === undefined) {
                agent.description = inheritedItem.description
              }
              if (item.description !== undefined) agent.description = item.description
              if (inheritedItem?.mode !== undefined && agent.mode === undefined) agent.mode = inheritedItem.mode
              if (item.mode !== undefined) agent.mode = item.mode
              if (inheritedItem?.hidden !== undefined && agent.hidden === undefined) agent.hidden = inheritedItem.hidden
              if (item.hidden !== undefined) agent.hidden = item.hidden
              if (inheritedItem?.color !== undefined && agent.color === undefined) agent.color = inheritedItem.color
              if (item.color !== undefined) agent.color = item.color
              if (inheritedItem?.steps !== undefined && agent.steps === undefined) agent.steps = inheritedItem.steps
              if (item.steps !== undefined) agent.steps = item.steps
              if (inheritedItem?.capability !== undefined && agent.capability === undefined) {
                agent.capability = inheritedItem.capability
              }
              if (item.capability !== undefined) agent.capability = item.capability
              if (inheritedItem?.workspace !== undefined && agent.workspace === undefined) {
                agent.workspace = inheritedItem.workspace
              }
              if (item.workspace !== undefined) agent.workspace = item.workspace
              if (inheritedItem?.permissions !== undefined && inheritedItem.permissions.length > 0) {
                agent.permissions.push(...expandPermissions(inheritedItem.permissions, global.home))
              }
              if (item.permissions !== undefined) {
                agent.permissions.push(...expandPermissions(item.permissions, global.home))
              }
              if (inheritedItem !== undefined) {
                const sources = { ...(agent.source ?? {}) }
                for (const field of ["model", "system", "description", "mode", "capability", "workspace"] as const) {
                  if (item[field] !== undefined) sources[field] = "explicit"
                  else if (inheritedItem[field] !== undefined) sources[field] = "inherited"
                }
                if (Object.keys(sources).length > 0) agent.source = sources
              }
            })
          }
        }
      }),
    )
  }),
})

/**
 * Resolve `extends` chains across all agent documents. Returns per-agent
 * merged definition (parent fields inherited unless the child overrides).
 * Cycle detection: A→B→A throws via Option.none → caller skips inheritance.
 */
function applyInheritance(documents: readonly Config.Document[]): Map<string, ConfigAgent.Info> {
  const table = new Map<string, ConfigAgent.Info>()
  for (const document of documents) {
    for (const [name, info] of Object.entries(document.info.agents ?? {})) {
      table.set(name, info)
    }
  }
  const resolved = new Map<string, ConfigAgent.Info>()
  const inheriting = new Set<string>()
  const visiting = new Set<string>()

  const resolve = (name: string): ConfigAgent.Info | undefined => {
    const cached = resolved.get(name)
    if (cached) return cached
    if (visiting.has(name)) {
      throw new Error(`Agent inheritance cycle detected: ${Array.from(visiting).join(" -> ")} -> ${name}`)
    }
    const self = table.get(name)
    if (!self) return undefined
    visiting.add(name)
    const parent = self.extends ? resolve(self.extends) : undefined
    visiting.delete(name)
    if (!parent) {
      // No inheritance chain: the agent stands alone — do not double-apply.
      resolved.set(name, self)
      return self
    }
    inheriting.add(name)
    const merged: ConfigAgent.Info = {
      ...parent,
      ...self,
      extends: undefined,
      // Deep-merge request (nested headers/body) so a child can extend the
      // parent's request without clobbering it; other fields are child-wins.
      request: parent.request || self.request
        ? {
            headers: { ...(parent.request?.headers ?? {}), ...(self.request?.headers ?? {}) },
            body: { ...(parent.request?.body ?? {}), ...(self.request?.body ?? {}) },
          }
        : undefined,
      // Only the parent's rules flow through inheritance; the child's own
      // rules are applied separately by the item loop (avoids double-push).
      permissions: parent.permissions ?? [],
    }
    resolved.set(name, merged)
    return merged
  }

  for (const name of table.keys()) {
    resolve(name)
  }
  // Only agents that actually inherit appear in the result.
  return new Map(Array.from(resolved.entries()).filter(([name]) => inheriting.has(name)))
}

function expandPermissions(rules: PermissionV2.Ruleset, home: string): PermissionV2.Ruleset {
  // Expand only resources tools resolve as filesystem paths. Bash resources are raw shell text:
  // rewriting `$HOME/private/**` would miss `$HOME/private/key`, and safe expansion needs shell-aware parsing.
  return rules.map((rule) =>
    isPathAction(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : rule,
  )
}

function isPathAction(action: string): action is PathAction {
  return pathActions.some((item) => item === action)
}

function expandHome(resource: string, home: string) {
  if (resource.startsWith("~/")) return home + resource.slice(1)
  if (resource === "~") return home
  if (resource === "$HOME") return home
  if (resource.startsWith("$HOME/")) return home + resource.slice(5)
  if (resource.startsWith("$HOME\\")) return home + resource.slice(5)
  return resource
}

function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(legacySources, (source) =>
    fs
      .glob(source.pattern, { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(
        Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
      ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.catch(() => Effect.succeed([])),
  )
}

function decode(file: { directory: string; filepath: string; primary: boolean }, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const name = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "")
  const body = markdown.content.trim()
  const legacy = Object.keys(markdown.data).some((key) => !agentKeys.has(key))
  const agent = Option.getOrUndefined(
    legacy
      ? Option.map(
          decodeLegacyAgent({ name, ...markdown.data, prompt: body }, { errors: "all", propertyOrder: "original" }),
          ConfigMigrateV1.migrateAgent,
        )
      : decodeAgent({ ...markdown.data, system: body }, { errors: "all", propertyOrder: "original" }),
  )
  if (!agent) return
  const info = Option.getOrUndefined(
    decodeConfig({
      agents: { [name]: file.primary ? { ...agent, mode: "primary" } : agent },
    }),
  )
  if (!info) return
  return new Config.Document({ type: "document", path: file.filepath, info })
}
