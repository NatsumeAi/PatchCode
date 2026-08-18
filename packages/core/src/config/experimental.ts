export * as ConfigExperimental from "./experimental"

import { Schema } from "effect"
import { Catalog } from "../catalog"
import { Policy as CorePolicy } from "../policy"

// Each core domain exports the policy actions it supports. Adding an action to
// this union makes it valid in authored config while keeping Policy generic.
export const PolicyAction = Schema.Union([Catalog.PolicyActions])

export class Policy extends Schema.Class<Policy>("Config.Experimental.Policy")({
  ...CorePolicy.Info.fields,
  action: PolicyAction,
}) {}

export class Experimental extends Schema.Class<Experimental>("Config.Experimental")({
  policies: Policy.pipe(Schema.Array, Schema.optional),
  continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
    description: "Continue the agent loop when a tool call is denied (official default: halt)",
  }),
}) {}
