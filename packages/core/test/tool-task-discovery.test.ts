/**
 * Task discovery appendix on materialize (V1 describeTask port).
 */
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { Agent } from "../src/agent"
import { Permission } from "../src/permission"
import { Tool } from "../src/tool/tool"
import { ToolRegistry } from "../src/tool/registry"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"

const stubTask = Tool.make({
  description: "Launch a new agent.",
  input: Schema.Struct({ prompt: Schema.String }),
  output: Schema.Struct({ ok: Schema.Boolean }),
  execute: () => Effect.succeed({ ok: true }),
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, Agent.node]), [[Location.node, tempLocationLayer]]),
)

describe("ToolRegistry task discovery (describeTaskAgents)", () => {
  it.effect("appends sorted callable agents; excludes primary/hidden/denied; tags capability", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.transform((draft) => {
        draft.update(Agent.ID.make("build"), (item) => {
          item.mode = "primary"
          item.hidden = false
          item.description = "primary"
        })
        draft.update(Agent.ID.make("zeta"), (item) => {
          item.mode = "subagent"
          item.hidden = false
          item.description = "Z agent"
        })
        draft.update(Agent.ID.make("alpha"), (item) => {
          item.mode = "subagent"
          item.hidden = false
          item.capability = "read-only"
          item.description = "A agent"
        })
        draft.update(Agent.ID.make("secret"), (item) => {
          item.mode = "subagent"
          item.hidden = true
          item.description = "hidden"
        })
        draft.update(Agent.ID.make("denied"), (item) => {
          item.mode = "subagent"
          item.hidden = false
          item.description = "nope"
        })
      })

      const registry = yield* ToolRegistry.Service
      yield* registry.register({ task: stubTask })

      const parentPermissions: Permission.Ruleset = [
        { action: "*", resource: "*", effect: "allow" },
        { action: "task", resource: "denied", effect: "deny" },
      ]
      const { definitions } = yield* registry.materialize({ permissions: parentPermissions })
      const desc = definitions.find((d) => d.name === "task")?.description ?? ""

      expect(desc).toContain("Launch a new agent.")
      expect(desc).toContain("Available agent types and the tools they have access to:")
      expect(desc).toContain("- alpha [read-only]: A agent")
      expect(desc).toContain("- zeta: Z agent")
      expect(desc).not.toContain("primary")
      expect(desc).not.toContain("hidden")
      expect(desc).not.toContain("nope")
      expect(desc).not.toContain("- denied")
      expect(desc).not.toContain("- build")
      expect(desc).not.toContain("- secret")
      expect(desc.indexOf("- alpha")).toBeLessThan(desc.indexOf("- zeta"))
    }),
  )
})
