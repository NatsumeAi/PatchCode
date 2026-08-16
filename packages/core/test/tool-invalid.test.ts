import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BuiltInTools } from "../src/tool/builtins"
import { ToolRegistry } from "../src/tool/registry"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { executeTool, toolIdentity } from "./lib/tool"
import { tempLocationLayer } from "./fixture/location"
import { SessionV2 } from "@opencode-ai/core/session"

const sessionID = SessionV2.ID.make("ses_invalid_tool_test")

const withRegistry = <A>(body: (registry: ToolRegistry.Interface) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, BuiltInTools.node]), [
        [Location.node, tempLocationLayer],
      ]),
    ),
  )

describe("invalid tool", () => {
  test("is registered but not advertised", async () => {
    const names = await Effect.runPromise(
      withRegistry((registry) =>
        Effect.gen(function* () {
          const materialized = yield* registry.materialize()
          return {
            advertised: materialized.definitions.map((tool) => tool.name),
            hidden: materialized.hidden,
          }
        }),
      ),
    )
    expect(names.advertised).not.toContain("invalid")
    expect(names.hidden).toContain("invalid")
  })

  test("unknown settle uses official invalid output", async () => {
    const result = await Effect.runPromise(
      withRegistry((registry) =>
        executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "missing", name: "missing", input: {} },
        }),
      ),
    )
    expect(result.type).toBe("text")
    if (result.type === "text") {
      expect(result.value).toContain("The arguments provided to the tool are invalid:")
      expect(result.value).toContain("Unknown tool: missing")
    }
  })
})
