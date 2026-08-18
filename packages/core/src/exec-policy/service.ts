export * as ExecPolicyService from "./service"
export * as ExecPolicy from "./service"

import fs from "fs/promises"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Global } from "../global"
import { Location } from "../location"
import { Trust } from "../trust"
import { Flag } from "../flag/flag"
import { classify } from "./parse"
import { reduce } from "./peel"
import { decideAsync, type DecideOptions, type Decision } from "./decide"
import { Invalid, loadBuiltin, mergePolicy, parseToml, type Policy } from "./load"
import { which } from "../util/which"

export interface Interface {
  readonly policy: () => Effect.Effect<Policy, Invalid>
  readonly reload: () => Effect.Effect<Policy, Invalid>
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
  let skippedUntrusted: string | undefined
  if (input.trusted) {
    const project = await readOptional(projectFile, projectFile)
    if (project) policy = mergePolicy(policy, project)
  } else {
    try {
      await fs.access(projectFile)
      skippedUntrusted = projectFile
    } catch {
      // no project file
    }
  }
  return Object.assign(policy, { skippedUntrusted })
}

const resolvedConfigDir = () => Flag.OPENCODE_CONFIG_DIR ?? Global.Path.config

/** Append a user-global allow prefix to exec-policy.toml (TOML, not Starlark). */
export const appendAllowPrefix = async (prefix: string[], configDir?: string) => {
  if (prefix.length === 0) return
  const dir = configDir ?? resolvedConfigDir()
  const file = path.join(dir, "exec-policy.toml")
  const block = `\n[[rule]]\nprefix = ${JSON.stringify(prefix)}\neffect = "allow"\n`
  await fs.mkdir(dir, { recursive: true })
  await fs.appendFile(file, block)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const configDir = resolvedConfigDir()
    const loadCached = () =>
      Effect.tryPromise({
        try: async () => {
          const trusted = await Trust.isTrusted(location.directory, { configDir })
          return loadMerged({ configDir, locationDir: location.directory, trusted })
        },
        catch: (error) => (error instanceof Invalid ? error : new Invalid(String(error))),
      })
    let cached = yield* loadCached()
    if (cached.skippedUntrusted) {
      yield* Effect.logWarning("Skipping untrusted project exec-policy.toml", { file: cached.skippedUntrusted })
    }
    const reload = () =>
      loadCached().pipe(
        Effect.tap((policy) => {
          cached = policy
          if (policy.skippedUntrusted) {
            return Effect.logWarning("Skipping untrusted project exec-policy.toml", { file: policy.skippedUntrusted })
          }
          return Effect.void
        }),
      )
    return Service.of({
      policy: () => Effect.succeed(cached),
      reload,
      decideCommand: (command, shell, options) =>
        Effect.tryPromise({
          try: async () => {
            const classified = await classify(command, shell)
            const reduced = await reduce(classified, { classify, depth: 0, source: command })
            return decideAsync(cached, reduced, {
              ...options,
              resolve:
                options?.resolve ??
                (async (argv0) => {
                  const found =
                    argv0.includes("/") || argv0.includes("\\") ? argv0 : (which(argv0) ?? argv0)
                  try {
                    return await fs.realpath(found)
                  } catch {
                    return found
                  }
                }),
            })
          },
          catch: (error) => (error instanceof Invalid ? error : new Invalid(String(error))),
        }),
    })
  }),
)

export const node = makeLocationNode({
  name: "exec-policy",
  service: Service,
  layer,
  deps: [Location.node],
})
