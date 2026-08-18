export * as PluginInternal from "./internal"

import { makeLocationNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import type { PluginContext } from "@opencode-ai/plugin/effect"
import { Effect, Layer, Scope } from "effect"
import { Agent } from "../agent"
import { Catalog } from "../catalog"
import { Command } from "../command"
import { Config } from "../config"
import { ConfigAgentPlugin } from "../config/plugin/agent"
import { ConfigCommandPlugin } from "../config/plugin/command"
import { ConfigExternalPlugin } from "../config/plugin/external"
import { ConfigProviderPlugin } from "../config/plugin/provider"
import { ConfigReferencePlugin } from "../config/plugin/reference"
import { ConfigSkillPlugin } from "../config/plugin/skill"
import { Event } from "../event"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Integration } from "../integration"
import { Location } from "../location"
import { ModelsDev } from "../models-dev"
import { Npm } from "../npm"
import { Plugin as CorePlugin } from "../plugin"
import { Reference } from "../reference"
import { Skill } from "../skill"
import { State } from "../state"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { AgentPlugin } from "./agent"
import { CommandPlugin } from "./command"
import { ModelsDevPlugin } from "./models-dev"
import { ProviderPlugins } from "./provider"
import { SkillPlugin } from "./skill"
import { VariantPlugin } from "./variant"

export type Requirements =
  | Agent.Service
  | Catalog.Service
  | Command.Service
  | Config.Service
  | Event.Service
  | FileSystem.Service
  | FSUtil.Service
  | Global.Service
  | HttpClient.HttpClient
  | Integration.Service
  | Location.Service
  | ModelsDev.Service
  | Npm.Service
  | Reference.Service
  | Skill.Service

export interface Plugin<R = never> {
  readonly id: string
  readonly effect: (context: PluginContext) => Effect.Effect<void, never, R | Scope.Scope>
}

export function define<R>(plugin: Plugin<R>) {
  return plugin
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const commands = yield* Command.Service
    const plugin = yield* CorePlugin.Service
    const integration = yield* Integration.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const location = yield* Location.Service
    const modelsDev = yield* ModelsDev.Service
    const npm = yield* Npm.Service
    const events = yield* Event.Service
    const fs = yield* FSUtil.Service
    const filesystem = yield* FileSystem.Service
    const global = yield* Global.Service
    const http = yield* HttpClient.HttpClient
    const skill = yield* Skill.Service
    const reference = yield* Reference.Service
    const add = <R>(input: Plugin<R>) => {
      const loaded = {
        id: input.id,
        effect: (context: PluginContext) =>
          input
            .effect(context)
            .pipe(
              Effect.provideService(Catalog.Service, catalog),
              Effect.provideService(Command.Service, commands),
              Effect.provideService(Integration.Service, integration),
              Effect.provideService(Agent.Service, agents),
              Effect.provideService(Config.Service, config),
              Effect.provideService(Location.Service, location),
              Effect.provideService(ModelsDev.Service, modelsDev),
              Effect.provideService(Npm.Service, npm),
              Effect.provideService(Event.Service, events),
              Effect.provideService(FSUtil.Service, fs),
              Effect.provideService(FileSystem.Service, filesystem),
              Effect.provideService(Global.Service, global),
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.provideService(Skill.Service, skill),
              Effect.provideService(Reference.Service, reference),
            ),
      }
      return plugin.add(CorePlugin.ID.make(loaded.id), loaded.effect)
    }

    yield* Effect.gen(function* () {
      yield* State.batch(
        Effect.gen(function* () {
          yield* add(ConfigReferencePlugin.Plugin)
          yield* add(AgentPlugin.Plugin)
          yield* add(CommandPlugin.Plugin)
          yield* add(SkillPlugin.Plugin)
          yield* add(ModelsDevPlugin)
          yield* add(ConfigAgentPlugin.Plugin)
          yield* add(ConfigCommandPlugin.Plugin)
          yield* add(ConfigSkillPlugin.Plugin)
          for (const item of ProviderPlugins) yield* add(item)
          yield* add(ConfigExternalPlugin.Plugin)
          yield* add(ConfigProviderPlugin.Plugin)
          yield* add(VariantPlugin.Plugin)
        }),
      )
      // After the batch reloads Catalog. SessionRunnerModel waits on this id the
      // way the legacy Provider.getModel waited for InstanceState.make to finish.
      yield* add({
        id: "internal-boot",
        effect: () => Effect.void,
      })
    }).pipe(Effect.withSpan("PluginInternal.boot"), Effect.forkScoped({ startImmediately: true }))
  }),
)

export const locationLayer = layer.pipe(
  Layer.provideMerge(Config.locationLayer),
  Layer.provideMerge(FetchHttpClient.layer),
)

export const node = makeLocationNode({
  name: "plugin-internal",
  layer,
  deps: [
    Catalog.node,
    Command.node,
    CorePlugin.node,
    Integration.node,
    Agent.node,
    Config.node,
    Location.node,
    ModelsDev.node,
    Npm.node,
    Event.node,
    FSUtil.node,
    FileSystem.node,
    Global.node,
    httpClient,
    Skill.node,
    Reference.node,
  ],
})
