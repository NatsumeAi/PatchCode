import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BuiltInTools } from "../src/tool/builtins"
import { ToolRegistry } from "../src/tool/registry"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { toolDefinitions } from "./lib/tool"
import { tempLocationLayer } from "./fixture/location"

const withRegistry = <A>(body: (registry: ToolRegistry.Interface) => Effect.Effect<A>) => {
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, BuiltInTools.node]),
        [[Location.node, tempLocationLayer]],
      ),
    ),
  )
}

const names = (capability: "read-only" | "read-write" | "execute" | "all") =>
  withRegistry((registry) =>
    toolDefinitions(registry, undefined, capability).pipe(Effect.map((definitions) => definitions.map((tool) => tool.name))),
  )

describe("ToolRegistry capability filter", () => {
  test("read-only excludes edit/write/apply_patch/bash", async () => {
    const result = await Effect.runPromise(names("read-only"))
    expect(result).not.toContain("edit")
    expect(result).not.toContain("write")
    expect(result).not.toContain("apply_patch")
    expect(result).not.toContain("bash")
    expect(result).toContain("read")
    expect(result).toContain("grep")
  })

  test("read-write includes edit but excludes bash", async () => {
    const result = await Effect.runPromise(names("read-write"))
    expect(result).toContain("edit")
    expect(result).toContain("write")
    expect(result).not.toContain("bash")
  })

  test("execute includes bash but excludes edit/write", async () => {
    const result = await Effect.runPromise(names("execute"))
    expect(result).toContain("bash")
    expect(result).not.toContain("edit")
    expect(result).not.toContain("write")
    expect(result).not.toContain("apply_patch")
  })

  test("all includes everything", async () => {
    const result = await Effect.runPromise(names("all"))
    expect(result).toContain("edit")
    expect(result).toContain("bash")
    expect(result).toContain("read")
  })

  test("capability undefined behaves like all (backward compatible)", async () => {
    const result = await Effect.runPromise(
      withRegistry((registry) => toolDefinitions(registry).pipe(Effect.map((d) => d.map((t) => t.name)))),
    )
    expect(result).toContain("edit")
    expect(result).toContain("bash")
  })
})
