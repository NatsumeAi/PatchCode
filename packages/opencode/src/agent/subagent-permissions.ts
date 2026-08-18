import type { Agent } from "./agent"
import { Permission, type Ruleset } from "../permission"

function isWritable(subagent: Agent.Info): boolean {
  if (subagent.writable !== undefined) return subagent.writable
  return Permission.evaluate("edit", "*", subagent.permission).effect === "allow"
}

export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: Ruleset
  subagent: Agent.Info
}): Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.action === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.action === "todowrite")
  const writable = isWritable(input.subagent)
  return [
    ...input.parentSessionPermission.filter((rule) => rule.action === "external_directory" || rule.effect === "deny"),
    ...(canTodo ? [] : [{ action: "todowrite" as const, resource: "*" as const, effect: "deny" as const }]),
    ...(canTask ? [] : [{ action: "task" as const, resource: "*" as const, effect: "deny" as const }]),
    ...(writable
      ? []
      : [
          { action: "edit" as const, resource: "*" as const, effect: "deny" as const },
          { action: "bash" as const, resource: "*" as const, effect: "deny" as const },
        ]),
  ]
}
