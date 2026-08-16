export * as HooksLoad from "./load"

import fs from "node:fs"
import path from "node:path"
import { Global } from "../global"
import { scanForThreatsInScope } from "../memory/scan"
import { Trust } from "../trust"
import { loadFile, type LoadedSpec, type Origin } from "./schema"

const readDirJson = (dir: string) => {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

const threatHit = (text: string, command?: string) =>
  scanForThreatsInScope(`${text}\n${command ?? ""}`, "strict").length > 0

export type DiscoverResult = {
  readonly specs: LoadedSpec[]
  readonly errors: { file: string; error: string }[]
  readonly untrusted: boolean
  readonly threats: string[]
}

const ingest = (file: string, origin: Origin, out: DiscoverResult) => {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch (error) {
    out.errors.push({ file, error: String(error) })
    return
  }
  const loaded = loadFile(text, { id: `${origin}:${path.basename(file, ".json")}`, origin, file })
  if (!loaded.ok) {
    out.errors.push({ file, error: loaded.error })
    return
  }
  if (loaded.unknownEvents && loaded.unknownEvents.length > 0) {
    out.errors.push({ file, error: `unknown events: ${loaded.unknownEvents.join(",")}` })
  }
  const commands = Object.values(loaded.spec.events)
    .flat()
    .flatMap((group) => group.hooks)
    .flatMap((hook) => (hook.type === "command" ? [hook.command] : []))
  if (threatHit(text, commands.join("\n"))) {
    out.threats.push(file)
    out.errors.push({ file, error: "threat" })
    return
  }
  if (Object.keys(loaded.spec.events).length === 0) return
  out.specs.push(loaded.spec)
}

export const discover = async (input: { location: string; configDir?: string; home?: string }): Promise<DiscoverResult> => {
  const configDir = input.configDir ?? Global.Path.config
  const home = input.home ?? process.env.OPENCODE_TEST_HOME ?? process.env.HOME ?? ""
  const out: DiscoverResult = { specs: [], errors: [], untrusted: false, threats: [] }

  for (const file of readDirJson(path.join(configDir, "hooks"))) ingest(file, "global", out)

  const trusted = await Trust.isTrusted(input.location, { configDir })
  if (!trusted) out.untrusted = true
  else {
    for (const file of readDirJson(path.join(input.location, ".opencode", "hooks"))) ingest(file, "project", out)
  }

  const compatGlobal = [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".claude", "settings.local.json"),
    path.join(home, ".cursor", "hooks.json"),
  ]
  for (const file of compatGlobal) if (fs.existsSync(file)) ingest(file, "global", out)

  if (trusted) {
    const compatProject = [
      path.join(input.location, ".claude", "settings.json"),
      path.join(input.location, ".claude", "settings.local.json"),
      path.join(input.location, ".cursor", "hooks.json"),
    ]
    for (const file of compatProject) if (fs.existsSync(file)) ingest(file, "project", out)
  }

  return out
}
