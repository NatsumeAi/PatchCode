import { ConfigPermission } from "@opencode-ai/core/config/legacy/permission"
import { evaluate as liveEvaluate, merge as liveMerge, disabled as liveDisabled } from "@opencode-ai/core/permission"
import { Permission } from "@opencode-ai/schema/permission"
import os from "os"

export type Rule = Permission.Rule
export type Ruleset = Permission.Ruleset
export type Effect = Permission.Effect

export function evaluate(action: string, resource: string, ...rulesets: Ruleset[]): Rule {
  return liveEvaluate(action, resource, ...rulesets)
}

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermission.Info): Ruleset {
  const ruleset: Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ action: key, resource: "*", effect: value })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([resource, effect]) => ({
        action: key,
        resource: expand(resource),
        effect,
      })),
    )
  }
  return ruleset
}

export function merge(...rulesets: Ruleset[]): Rule[] {
  return [...liveMerge(...rulesets)]
}

export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  return liveDisabled(tools, ruleset)
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export * as Permission from "."
