export * as ExecPolicyService from "./service"

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Global } from "../global"
import { Location } from "../location"
import { Trust } from "../trust"
import { classify } from "./parse"
import { reduce } from "./peel"
import { decide, type DecideOptions, type Decision } from "./decide"
import { Invalid, loadBuiltin, mergePolicy, parseToml, type Policy } from "./load"

export interface Interface {
  readonly policy: () => Effect.Effect<Policy, Invalid>
  readonly decideCommand: (
    command: string,
    shell: string,
    options?: DecideOptions,
  ) => Effect.Effect<Decision, Invalid>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ExecPolicy") {}

const readOptional = async (file: string, label: string) => {
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new Invalid(`${label}: ${String(error)}`)
  }
  return parseToml(text, label)
}

export const loadMerged = async (input: { configDir?: string; locationDir: string; trusted: boolean }) => {
  let policy = await loadBuiltin()
  const userFile = path.join(input.configDir ?? Global.Path.config, "exec-policy.toml")
  const user = await readOptional(userFile, userFile)
  if (user) policy = mergePolicy(policy, user)
  const projectFile = path.join(input.locationDir, ".opencode", "exec-policy.toml")
  if (input.trusted) {
    const project = await readOptional(projectFile, projectFile)
    if (project) policy = mergePolicy(policy, project)
  }
  return policy
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const configDir = Global.Path.config
    const cached = yield* Effect.tryPromise({
      try: async () => {
        const trusted = await Trust.isTrusted(location.directory, { configDir })
        return loadMerged({ configDir, locationDir: location.directory, trusted })
      },
      catch: (error) => (error instanceof Invalid ? error : new Invalid(String(error))),
    })
    return Service.of({
      policy: () => Effect.succeed(cached),
      decideCommand: (command, shell, options) =>
        Effect.tryPromise({
          try: async () => {
            const classified = await classify(command, shell)
            const reduced = await reduce(classified, { classify, depth: 0, source: command })
            return decide(cached, reduced, options)
          },
          catch: (error) => (error instanceof Invalid ? error : new Invalid(String(error))),
        }),
    })
  }),
)

export const node = makeLocationNode({
  name: "exec-policy",
  layer,
  deps: [Location.node],
})
