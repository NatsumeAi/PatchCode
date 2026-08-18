export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { mkdir, copyFile } from "node:fs/promises"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { evaluate as evaluatePermission } from "./permission/evaluate"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { SkillLock } from "./skill/lock"
import { State } from "./state"
import { Trust } from "./trust"
import { scanForThreatsInScope } from "./memory/scan"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => evaluatePermission("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service
    const globalOpt = yield* Effect.serviceOption(Global.Service)
    const locationOpt = yield* Effect.serviceOption(Location.Service)
    const configDir = globalOpt._tag === "Some" ? globalOpt.value.config : Global.Path.config

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") return [source.skill]
      if (source.type === "url" && source.url.trim().toLowerCase().startsWith("file:")) return []
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const filepath of files.toSorted()) {
          const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!content) continue
          const markdown = ConfigMarkdown.parseOption(content)
          if (!markdown) continue
          const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
          if (!frontmatter) continue
          const name =
            frontmatter.name !== undefined
              ? frontmatter.name
              : path.dirname(filepath) === directory
                ? path.basename(filepath, ".md")
                : undefined
          if (!name) continue
          const threats = scanForThreatsInScope(
            `${name}\n${frontmatter.description ?? ""}\n${markdown.content}`,
            "context",
          )
          if (threats.length > 0) {
            yield* Effect.logError("SkillV2 rejected by threat scan", { skill: name, path: filepath, threats })
            continue
          }
          skills.push({
            name,
            description: frontmatter.description,
            slash: frontmatter.slash,
            location: AbsolutePath.make(filepath),
            content: markdown.content,
          })
        }
      }
      if (source.type === "url") {
        for (const skill of skills) {
          const existing = yield* Effect.promise(() => SkillLock.get(skill.name, configDir))
          if (existing?.state === "active") continue
          const dest = path.join(SkillLock.skillsDir(configDir), skill.name)
          yield* Effect.promise(async () => {
            await mkdir(dest, { recursive: true })
            await copyFile(skill.location, path.join(dest, "SKILL.md"))
          })
          yield* Effect.promise(() =>
            SkillLock.upsert(
              {
                name: skill.name,
                source: "url",
                uri: source.url,
                sha256: SkillLock.hashText(skill.content),
                installedAt: Date.now(),
                state: "quarantine",
              },
              configDir,
            ),
          )
        }
      }
      return skills
    })

    // QUESTION(Dax): Should local skill sources invalidate on filesystem watch
    // events, following the reload policy chosen for other context sources?
    const cache = new Map<string, Info[]>()
    const list = Effect.fn("SkillV2.list")(function* () {
      const skills = new Map<string, Info>()
      const locationDir = locationOpt._tag === "Some" ? String(locationOpt.value.directory) : undefined
      const projectTrusted =
        locationDir === undefined ? true : yield* Effect.promise(() => Trust.isTrusted(locationDir, { configDir }))
      const skipProject = (source: Source) => {
        if (source.type !== "directory" || !locationDir) return false
        const dir = String(source.path)
        if (!FSUtil.contains(locationDir, dir)) return false
        if (!dir.includes(`${path.sep}.opencode${path.sep}`) && !dir.endsWith(`${path.sep}.opencode`)) return false
        return !projectTrusted
      }
      for (const source of state.get().sources) {
        if (skipProject(source)) continue
        const key = Source.key(source)
        const loaded = cache.get(key) ?? (yield* load(source))
        cache.set(key, loaded)
      }
      const quarantined = yield* Effect.promise(() => SkillLock.quarantinedNames(configDir))
      for (const source of state.get().sources) {
        if (skipProject(source)) continue
        for (const skill of cache.get(Source.key(source)) ?? []) {
          if (quarantined.has(skill.name)) continue
          skills.set(skill.name, skill)
        }
      }
      const lock = yield* Effect.promise(() => SkillLock.read(configDir))
      for (const row of lock.skills) {
        if (row.state !== "active" || skills.has(row.name)) continue
        const directory = AbsolutePath.make(path.join(SkillLock.skillsDir(configDir), row.name))
        const loaded = yield* load(DirectorySource.make({ type: "directory", path: directory }))
        for (const skill of loaded) {
          if (quarantined.has(skill.name)) continue
          skills.set(skill.name, skill)
        }
      }
      return Array.from(skills.values())
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [SkillDiscovery.node, FSUtil.node, Global.node, Location.node],
})
