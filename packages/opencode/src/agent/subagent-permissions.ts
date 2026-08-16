import { PermissionV1 } from "@opencode-ai/core/permission-legacy"
import type { Agent } from "./agent"
import { Permission } from "../permission"

function isWritable(subagent: Agent.Info): boolean {
  if (subagent.writable !== undefined) return subagent.writable
  // Default derives from the subagent's own permission: a subagent whose own
  // ruleset grants `edit` is an executor (writable); otherwise it is a review
  // subagent and stays read-only. This preserves existing built-in subagents
  // (general/explore/etc.) while making new subagents read-only by default.
  return Permission.evaluate("edit", "*", subagent.permission).action === "allow"
}

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 * 3. L7 write 单线程化 (loop-design.md §6d): non-writable subagents cannot
 *    Write/Edit/apply_patch (all route through the `edit` permission) or run
 *    bash at all. A command-string deny-list cannot safely account for shell
 *    operators, nested shells, find -exec, interpreters, or Git write paths.
 *    `writable` defaults to the subagent's own `edit` grant; explicit
 *    `writable: true`/`false` override the derivation.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const writable = isWritable(input.subagent)
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(writable
      ? []
      : [
          { permission: "edit" as const, pattern: "*" as const, action: "deny" as const },
          { permission: "bash" as const, pattern: "*" as const, action: "deny" as const },
        ]),
  ]
}
