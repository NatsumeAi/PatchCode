export * as PersonaLoader from "./loader"

import { Effect } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { PersonaInfo } from "./schema"

/**
 * Load named personas from workspace `.opencode/personas/*` then user config.
 * Markdown: optional YAML frontmatter (name, description, inputs, outputs, capability,
 * instructions_file) + body as instructions.
 */
export const loadCatalog = (input: {
  readonly projectDirectory: string
  readonly userConfigDirectory?: string
}): Effect.Effect<Map<string, PersonaInfo>> =>
  Effect.gen(function* () {
    const map = new Map<string, PersonaInfo>()
    const dirs = [
      path.join(input.projectDirectory, ".opencode", "personas"),
      ...(input.userConfigDirectory
        ? [path.join(input.userConfigDirectory, "personas")]
        : []),
    ]
    for (const dir of dirs) {
      const files = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await fs.readdir(dir)
          } catch {
            return [] as string[]
          }
        },
        catch: () => [] as string[],
      })
      for (const file of files) {
        if (!file.endsWith(".md") && !file.endsWith(".mdx")) continue
        const full = path.join(dir, file)
        const raw = yield* Effect.tryPromise({
          try: () => fs.readFile(full, "utf8"),
          catch: () => "",
        })
        if (!raw) continue
        const parsed = parsePersonaMarkdown(file.replace(/\.(md|mdx)$/i, ""), raw)
        if (!map.has(parsed.name)) map.set(parsed.name, parsed)
      }
    }
    return map
  })

export function parsePersonaMarkdown(fallbackName: string, raw: string): PersonaInfo {
  let name = fallbackName
  let description: string | undefined
  let instructions_file: string | undefined
  let capability: PersonaInfo["capability"]
  let inputs: string[] | undefined
  let outputs: string[] | undefined
  let body = raw
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (fm) {
    const yaml = fm[1]!
    body = fm[2]!
    for (const line of yaml.split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/)
      if (!m) continue
      const key = m[1]!
      const val = m[2]!.trim().replace(/^["']|["']$/g, "")
      if (key === "name") name = val
      else if (key === "description") description = val
      else if (key === "instructions_file") instructions_file = val
      else if (key === "capability" && ["read-only", "read-write", "execute", "all"].includes(val)) {
        capability = val as PersonaInfo["capability"]
      } else if (key === "inputs") inputs = val.split(",").map((s) => s.trim()).filter(Boolean)
      else if (key === "outputs") outputs = val.split(",").map((s) => s.trim()).filter(Boolean)
    }
  }
  return {
    name,
    instructions: body.trim() || undefined,
    instructions_file,
    description,
    inputs,
    outputs,
    capability,
  } satisfies PersonaInfo
}

/** Soft-fail path-contained read relative to project root. */
export const safeReadInstructionsFile = (
  projectDirectory: string,
  relativeOrAbsolute: string,
): Effect.Effect<string | undefined> =>
  Effect.tryPromise({
    try: async () => {
      const resolved = path.resolve(projectDirectory, relativeOrAbsolute)
      const root = path.resolve(projectDirectory) + path.sep
      if (resolved !== path.resolve(projectDirectory) && !resolved.startsWith(root)) {
        return undefined
      }
      const real = await fs.realpath(resolved).catch(() => resolved)
      if (real !== path.resolve(projectDirectory) && !real.startsWith(root)) return undefined
      return await fs.readFile(real, "utf8")
    },
    catch: () => undefined as string | undefined,
  })
