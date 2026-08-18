import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Context, Option, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { Command as CoreCommand } from "@opencode-ai/core/command"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
  LOOP: "loop",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: false,
        hints: hints(PROMPT_REVIEW),
      }
      commands[Default.LOOP] = {
        name: Default.LOOP,
        description: "inspect and control the session loop",
        source: "command",
        template: "",
        hints: [],
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        const dir = item.location === "<built-in>" ? undefined : path.dirname(item.location)
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            if (!dir) return item.content
            return [
              item.content,
              "",
              `Base directory for this skill: ${dir}`,
              "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
            ].join("\n")
          },
          hints: [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const fromCore = (item: CoreCommand.Info): Info => {
      const model =
        item.model === undefined
          ? undefined
          : `${item.model.providerID}/${item.model.id}${item.model.variant ? `:${item.model.variant}` : ""}`
      return {
        name: item.name,
        description: item.description,
        agent: item.agent,
        model,
        source: "command",
        template: item.template,
        subtask: item.subtask,
        hints: hints(item.template),
      }
    }

    /** Live CoreCommand merge via LocationServiceMap (W10). serviceOption(CoreCommand) at
     * instance init is always None — CoreCommand is location-scoped. */
    const listCore = Effect.fn("Command.listCore")(function* () {
      // LocationServiceMap is global (AppLayer). CoreCommand lives inside a location
      // layer — resolve it via locations.get(ref), never serviceOption(CoreCommand).
      const locations = yield* Effect.serviceOption(LocationServiceMap.Service)
      if (Option.isNone(locations)) return [] as CoreCommand.Info[]
      const ctx = yield* InstanceState.context
      const ref = Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) })
      return yield* Effect.gen(function* () {
        const v2 = yield* CoreCommand.Service
        return yield* v2.list()
      }).pipe(
        Effect.provide(locations.value.get(ref)),
        Effect.catch(() => Effect.succeed([] as CoreCommand.Info[])),
      )
    })

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      if (s.commands[name]) return s.commands[name]
      const extras = yield* listCore()
      const hit = extras.find((item) => item.name === name)
      return hit ? fromCore(hit) : undefined
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      const extras = yield* listCore()
      const merged = { ...s.commands }
      for (const item of extras) {
        if (merged[item.name]) continue
        merged[item.name] = fromCore(item)
      }
      return Object.values(merged)
    })

    return Service.of({ get, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node, MCP.node, Skill.node] })

export * as Command from "."
