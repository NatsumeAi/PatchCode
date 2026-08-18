export * as SubagentPermissions from "./subagent-permissions"

import { Permission } from "@opencode-ai/schema/permission"
import { Agent } from "../agent"
import { Wildcard } from "../util/wildcard"

export type CapabilityMode = "read-only" | "read-write" | "execute" | "all"

/** Capability rank: lower = tighter. Persona may only tighten (min of ranks). */
export const CAPABILITY_RANK: Record<CapabilityMode, number> = {
  "read-only": 0,
  "read-write": 1,
  execute: 2,
  all: 3,
}

/**
 * Persona capability may only tighten the agent ceiling — never widen.
 * Returns the tighter of agent vs persona (min rank).
 */
export function tightenCapability(
  agentCeiling: CapabilityMode | undefined,
  personaRequest: CapabilityMode | undefined,
): CapabilityMode | undefined {
  if (personaRequest === undefined) return agentCeiling
  if (agentCeiling === undefined) return personaRequest
  return CAPABILITY_RANK[personaRequest] <= CAPABILITY_RANK[agentCeiling] ? personaRequest : agentCeiling
}


function isWritable(subagent: Agent.Info): boolean {
  // Ruleset-derived (no explicit writable field on Agent.Info): an agent whose
  // own ruleset grants `edit` is an executor (writable); otherwise read-only.
  const rule = subagent.permissions.findLast(
    (r) => Wildcard.match("edit", r.action) && Wildcard.match("*", r.resource),
  )
  return rule?.effect === "allow"
}

/**
 * Build the permission ruleset for a subagent's session when spawned via the
 * task tool. Capability filtering stays on this path.
 *
 * 1. Parent deny + parent external_directory rules are inherited as hard ceilings.
 * 2. todowrite/task denied by default unless the subagent's own ruleset permits
 *    them (recursion guard).
 * 3. Non-writable subagents cannot edit or run bash at all (write serialization).
 * 4. capability narrows the tool surface orthogonally:
 *    read-only  → deny all write paths (edit/write/apply_patch/bash)
 *    read-write → deny bash (writable but no shell)
 *    execute    → allow bash but deny edit/write/apply_patch
 *    all        → no extra filtering
 */
export function deriveSubagentPermission(input: {
  parentPermissions: Permission.Ruleset
  subagent: Agent.Info
  capability?: CapabilityMode
}): Permission.Ruleset {
  const canTask = input.subagent.permissions.some((rule) => rule.action === "task")
  const canTodo = input.subagent.permissions.some((rule) => rule.action === "todowrite")
  const writable = isWritable(input.subagent)
  const capabilityRules: Permission.Ruleset =
    input.capability === "read-only"
      ? [
          { action: "edit", resource: "*", effect: "deny" },
          { action: "write", resource: "*", effect: "deny" },
          { action: "apply_patch", resource: "*", effect: "deny" },
          { action: "bash", resource: "*", effect: "deny" },
        ]
      : input.capability === "read-write"
        ? [{ action: "bash", resource: "*", effect: "deny" }]
        : input.capability === "execute"
          ? [
              { action: "edit", resource: "*", effect: "deny" },
              { action: "write", resource: "*", effect: "deny" },
              { action: "apply_patch", resource: "*", effect: "deny" },
            ]
          : []
  return [
    ...input.parentPermissions.filter((rule) => rule.action === "external_directory" || rule.effect === "deny"),
    ...(canTodo ? [] : [{ action: "todowrite" as const, resource: "*" as const, effect: "deny" as const }]),
    ...(canTask ? [] : [{ action: "task" as const, resource: "*" as const, effect: "deny" as const }]),
    ...(writable
      ? []
      : [
          { action: "edit" as const, resource: "*" as const, effect: "deny" as const },
          { action: "bash" as const, resource: "*" as const, effect: "deny" as const },
        ]),
    ...capabilityRules,
  ]
}
