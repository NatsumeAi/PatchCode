export * as PermissionEvaluate from "./evaluate"

import { Permission } from "@opencode-ai/schema/permission"
import { Wildcard } from "../util/wildcard"

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

/** Hide a tool only when the last matching action rule is a `*` resource deny. */
export function disabled(tools: string[], ruleset: Permission.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const action = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((item) => Wildcard.match(action, item.action))
      return rule?.resource === "*" && rule.effect === "deny"
    }),
  )
}
