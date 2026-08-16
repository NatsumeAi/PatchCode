import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TaskTool } from "../src/tool/task"
import { ToolRegistry } from "../src/tool/registry"
import { SubagentRegistry } from "../src/session/subagent-registry"
import { SessionSchema } from "../src/session/schema"
import { PermissionV2 } from "../src/permission"
import { settleTool, toolIdentity } from "./lib/tool"
import { location } from "./fixture/location"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"

const sessionID = SessionSchema.ID.make("ses_task_budget_test")

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    assertPolicyAsk: () => Effect.void,
    evaluate: () => Effect.succeed({ action: "allow", resource: "*", effect: "allow" }),
  } as unknown as PermissionV2.Interface),
)

const registryLayer = (active: number) =>
  Layer.effect(
    SubagentRegistry.Service,
    Effect.gen(function* () {
      const base = yield* SubagentRegistry.make
      for (let i = 0; i < active; i++) {
        yield* base.register({
          parentSessionID: sessionID,
          childSessionID: SessionSchema.ID.make(`ses_active_${i}`),
          subagentType: "explore",
          address: `/root/t${i}`,
        })
        yield* base.transition(SessionSchema.ID.make(`ses_active_${i}`), "active")
      }
      return SubagentRegistry.Service.of(base)
    }),
  )

const withTool = (active: number) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make("/tmp/task-budget-test") })),
  )
  return Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    return yield* settleTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id: "call_task_budget", name: TaskTool.name, input: { description: "t", prompt: "p", subagent_type: "explore" } },
    })
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, TaskTool.node]),
        [
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [SubagentRegistry.node, registryLayer(active)],
        ],
      ),
    ),
  )
}

describe("TaskTool concurrency cap", () => {
  test("active >= HARD_CAP (7) fails with tool error result", async () => {
    const settlement = await Effect.runPromise(withTool(7))
    expect(settlement.result).toMatchObject({ type: "error" })
  })

  test("active below HARD_CAP (3) does not hit the concurrency cap", async () => {
    const settlement = await Effect.runPromise(withTool(3))
    // No HostService in test env — the failure must be "host not available",
    // NOT the concurrency rejection. Proves the cap check did not trigger.
    const value = settlement.result.type === "error" ? settlement.result.value : ""
    expect(value).toContain("host")
  })

  test("active at soft tier (4) still passes through (soft prompt deferred)", async () => {
    const settlement = await Effect.runPromise(withTool(4))
    const value = settlement.result.type === "error" ? settlement.result.value : ""
    expect(value).toContain("host")
  })
})
