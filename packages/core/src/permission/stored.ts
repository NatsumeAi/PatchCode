export * as PermissionStored from "./stored"

import { Permission } from "@opencode-ai/schema/permission"

function effect(value: unknown): Permission.Effect | undefined {
  if (value === "allow" || value === "deny" || value === "ask") return value
  return undefined
}

/** One-way decode of a stored rule. Old disk rows used {permission, pattern, action}. */
export function rule(raw: unknown): Permission.Rule | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  const live = effect(row.effect)
  if (live && typeof row.action === "string" && typeof row.resource === "string") {
    return { action: row.action, resource: row.resource, effect: live }
  }
  const legacy = effect(row.action)
  if (legacy && typeof row.permission === "string" && typeof row.pattern === "string") {
    return { action: row.permission, resource: row.pattern, effect: legacy }
  }
  return undefined
}

export function ruleset(raw: unknown): Permission.Ruleset | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) return undefined
  const out: Permission.Rule[] = []
  for (const item of raw) {
    const next = rule(item)
    if (next) out.push(next)
  }
  return out
}
