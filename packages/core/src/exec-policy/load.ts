export * as ExecPolicyLoad from "./load"

import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { which } from "../util/which"

export type EffectName = "allow" | "ask" | "deny"

export interface Rule {
  readonly prefix: string[]
  readonly effect: EffectName
  readonly reason?: string
}

export interface HostPin {
  readonly name: string
  readonly paths: string[]
}

export interface Policy {
  readonly rules: Rule[]
  readonly hosts: HostPin[]
}

export class Invalid extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExecPolicy.Invalid"
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asStringArray = (value: unknown) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined
  return value as string[]
}

const parseRules = (raw: unknown, label: string): Policy => {
  if (!isRecord(raw)) throw new Invalid(`${label}: not a table`)
  const rulesRaw = raw.rule
  const list = rulesRaw === undefined ? [] : Array.isArray(rulesRaw) ? rulesRaw : [rulesRaw]
  const rules: Rule[] = []
  for (const item of list) {
    if (!isRecord(item)) throw new Invalid(`${label}: rule is not a table`)
    const prefix = asStringArray(item.prefix)
    const effect = item.effect
    if (!prefix || prefix.length === 0) throw new Invalid(`${label}: rule missing prefix`)
    if (effect !== "allow" && effect !== "ask" && effect !== "deny") throw new Invalid(`${label}: bad effect`)
    rules.push({ prefix, effect, reason: typeof item.reason === "string" ? item.reason : undefined })
  }
  const hostsRaw = raw.host
  const hostsList = hostsRaw === undefined ? [] : Array.isArray(hostsRaw) ? hostsRaw : [hostsRaw]
  const hosts: HostPin[] = []
  for (const item of hostsList) {
    if (!isRecord(item)) throw new Invalid(`${label}: host is not a table`)
    const name = item.name
    const paths = asStringArray(item.paths)
    if (typeof name !== "string" || !paths) throw new Invalid(`${label}: host needs name+paths`)
    hosts.push({ name, paths })
  }
  return { rules, hosts }
}

export const matchesPrefix = (argv: string[], prefix: string[]) => {
  if (argv.length < prefix.length) return false
  return prefix.every((token, i) => {
    if (token.endsWith("*") && token.length > 1) {
      const stem = token.slice(0, -1)
      return argv[i] === stem || argv[i].startsWith(stem)
    }
    return argv[i] === token
  })
}

export const longestPrefix = (argv: string[], rules: Rule[]) => {
  let best: Rule | undefined
  for (const rule of rules) {
    if (!matchesPrefix(argv, rule.prefix)) continue
    if (!best || rule.prefix.length >= best.prefix.length) best = rule
  }
  return best
}

const asMatchRow = (value: unknown) => {
  if (!isRecord(value)) return undefined
  const argv = asStringArray(value.argv)
  if (!argv) return undefined
  return {
    argv,
    expect: typeof value.expect === "string" ? value.expect : undefined,
    prefix: asStringArray(value.prefix),
  }
}

export const parseToml = (text: string, label: string) => {
  let raw: unknown
  try {
    raw = Bun.TOML.parse(text)
  } catch (error) {
    throw new Invalid(`${label}: toml parse failed: ${String(error)}`)
  }
  return parseRules(raw, label)
}

const validateDecideFixtures = async (text: string, policy: Policy, label: string) => {
  let raw: unknown
  try {
    raw = Bun.TOML.parse(text)
  } catch {
    return
  }
  if (!isRecord(raw)) return
  const { decide } = await import("./decide")
  const matches = raw.match === undefined ? [] : Array.isArray(raw.match) ? raw.match : [raw.match]
  for (const item of matches) {
    const row = asMatchRow(item)
    if (!row || !row.expect) throw new Invalid(`${label}: match fixture needs argv+expect`)
    const hit = decide(policy, { tag: "segments", segments: [row.argv] })
    if (hit.effect !== row.expect) {
      throw new Invalid(
        `${label}: match ${JSON.stringify(row.argv)} expected ${row.expect}, got ${hit.effect}`,
      )
    }
  }
  const notMatches = raw.not_match === undefined ? [] : Array.isArray(raw.not_match) ? raw.not_match : [raw.not_match]
  for (const item of notMatches) {
    const row = asMatchRow(item)
    if (!row || !row.prefix) throw new Invalid(`${label}: not_match fixture needs argv+prefix`)
    if (matchesPrefix(row.argv, row.prefix)) {
      throw new Invalid(`${label}: not_match ${JSON.stringify(row.argv)} must not match ${JSON.stringify(row.prefix)}`)
    }
  }
}

export const mergePolicy = (base: Policy, overlay: Policy): Policy => ({
  rules: [...base.rules, ...overlay.rules],
  hosts: [...base.hosts, ...overlay.hosts],
})

const HOST_PIN_NAMES = ["git", "ls", "pwd", "echo", "true", "false", "printf", "rg", "grep", "find", "cat"]

const resolveHostPins = async (): Promise<HostPin[]> => {
  const hosts: HostPin[] = []
  for (const name of HOST_PIN_NAMES) {
    const found = which(name)
    if (!found) continue
    try {
      const resolved = await fs.realpath(found)
      hosts.push({ name, paths: [resolved] })
    } catch {
      hosts.push({ name, paths: [found] })
    }
  }
  return hosts
}

export const loadBuiltin = async (): Promise<Policy> => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin.toml")
  const text = await Bun.file(file).text()
  const policy = parseToml(text, "builtin.toml")
  await validateDecideFixtures(text, policy, "builtin.toml")
  const hosts = await resolveHostPins()
  return hosts.length > 0 ? mergePolicy(policy, { rules: [], hosts }) : policy
}
