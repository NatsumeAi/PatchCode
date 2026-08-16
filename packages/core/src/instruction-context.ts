export * as InstructionContext from "./instruction-context"

import { Array, Effect, Layer, Option, Schema } from "effect"
import { basename, dirname, isAbsolute, join, relative, resolve as pathResolve, sep } from "path"
import { homedir } from "os"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Flag } from "./flag/flag"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"
import { makeLocationNode } from "./effect/app-node"

class File extends Schema.Class<File>("InstructionContext.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = SystemContext.Key.make("core/instructions")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const configOpt = yield* Effect.serviceOption(Config.Service)

    const source = (value: ReadonlyArray<File> | SystemContext.Unavailable) =>
      SystemContext.make({
        key,
        codec: Schema.toCodecJson(Files),
        load: Effect.succeed(value),
        baseline: render,
        update: (_previous, current) =>
          `These instructions replace all previously loaded ambient instructions.\n\n${render(current)}`,
        removed: () => "Previously loaded instructions no longer apply.",
      })

    const projectTargets = Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
      ? ["AGENTS.md", "CONTEXT.md"]
      : ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]

    const observe = Effect.fn("InstructionContext.observe")(function* () {
      const start = yield* fs.resolve(location.directory)
      const stop = yield* fs.resolve(location.project.directory)
      const fromProject = relative(stop, start)
      const insideProject =
        fromProject === "" || (fromProject !== ".." && !fromProject.startsWith(`..${sep}`) && !isAbsolute(fromProject))
      const discovered = new Set(
        yield* Effect.forEach(
          Flag.OPENCODE_DISABLE_PROJECT_CONFIG || !insideProject
            ? []
            : yield* fs.up({
                targets: projectTargets,
                start,
                stop,
              }),
          fs.resolve,
        ),
      )
      const globalPaths = [
        yield* fs.resolve(join(global.config, "AGENTS.md")),
        ...(Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
          ? []
          : [yield* fs.resolve(join(homedir(), ".claude", "CLAUDE.md"))]),
      ]
      const extras = Option.isSome(configOpt)
        ? (Config.latest(yield* configOpt.value.entries(), "instructions") ?? [])
        : []
      const extraPaths: string[] = []
      const extraUrls: string[] = []
      for (const raw of extras) {
        if (raw.startsWith("https://") || raw.startsWith("http://")) {
          extraUrls.push(raw)
          continue
        }
        const instruction = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw
        const matches = yield* (
          isAbsolute(instruction)
            ? fs.glob(basename(instruction), {
                cwd: dirname(instruction),
                absolute: true,
                include: "file" as const,
              })
            : Flag.OPENCODE_DISABLE_PROJECT_CONFIG
              ? fs.globUp(instruction, global.config, global.config)
              : fs.globUp(instruction, start, stop)
        ).pipe(Effect.catch(() => Effect.succeed([] as string[])))
        for (const match of matches) extraPaths.push(pathResolve(match))
      }
      const remote = yield* Effect.forEach(
        extraUrls,
        (url) =>
          Effect.tryPromise({
            try: async () => {
              const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
              if (!res.ok) return undefined
              const content = await res.text()
              return content.trim() ? new File({ path: AbsolutePath.make(url), content }) : undefined
            },
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined))),
        { concurrency: 4 },
      )
      const paths = Array.dedupe([...globalPaths, ...discovered, ...extraPaths])
      const files = yield* Effect.forEach(
        paths,
        (path) =>
          fs
            .readFileStringSafe(path)
            .pipe(
              Effect.map((content) =>
                content === undefined ? undefined : new File({ path: AbsolutePath.make(path), content }),
              ),
            ),
        { concurrency: "unbounded" },
      )
      if (files.some((file, index) => file === undefined && discovered.has(paths[index]!)))
        return SystemContext.unavailable
      return [
        ...files.filter((file): file is File => file !== undefined),
        ...remote.filter((file): file is File => file !== undefined),
      ]
    })

    yield* registry.register({
      key,
      load: observe().pipe(
        Effect.map((files) =>
          files === SystemContext.unavailable
            ? source(files)
            : files.length === 0
              ? SystemContext.empty
              : source(files),
        ),
        Effect.catch(() => Effect.succeed(source(SystemContext.unavailable))),
        Effect.catchDefect(() => Effect.succeed(source(SystemContext.unavailable))),
      ),
    })
  }),
)

export const node = makeLocationNode({
  name: "instruction-context",
  layer,
  deps: [FSUtil.node, Global.node, Location.node, SystemContextRegistry.node, Config.node],
})

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}

const nearbyTargets = Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
  ? ["AGENTS.md", "CONTEXT.md"]
  : ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]

const nearbyClaims = new Map<string, Set<string>>()

export const clearNearby = (messageID: string) => {
  nearbyClaims.delete(messageID)
}

/**
 * Official leftover Instruction.resolve: walk up from the file being read and
 * attach nearby instruction files once per message. Ambient system files from
 * InstructionContext are skipped — those already live in system context.
 */
export const nearby = Effect.fn("InstructionContext.nearby")(function* (input: {
  readonly filepath: string
  readonly messageID: string
  readonly root: string
  readonly ambient: ReadonlySet<string>
  readonly already: ReadonlySet<string>
}) {
  const fs = yield* FSUtil.Service
  const results: { filepath: string; content: string }[] = []
  const target = pathResolve(input.filepath)
  const root = pathResolve(input.root)
  let current = dirname(target)
  let claims = nearbyClaims.get(input.messageID)
  if (!claims) {
    claims = new Set()
    nearbyClaims.set(input.messageID, claims)
  }
  while (current.startsWith(root) && current !== root) {
    let found: string | undefined
    for (const name of nearbyTargets) {
      const candidate = pathResolve(join(current, name))
      if (yield* fs.existsSafe(candidate)) {
        found = candidate
        break
      }
    }
    if (!found || found === target || input.ambient.has(found) || input.already.has(found) || claims.has(found)) {
      current = dirname(current)
      continue
    }
    claims.add(found)
    const content = yield* fs.readFileStringSafe(found)
    if (content) results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
    current = dirname(current)
  }
  return results
})
