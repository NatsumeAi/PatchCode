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
    expect(result).not.toContain("invalid")
  })

  test("capability undefined behaves like all (backward compatible)", async () => {
    const result = await Effect.runPromise(
      withRegistry((registry) => toolDefinitions(registry).pipe(Effect.map((d) => d.map((t) => t.name)))),
    )
    expect(result).toContain("edit")
    expect(result).toContain("bash")
    expect(result).not.toContain("invalid")
  })
})

test("read-only and execute exclude memory_add_note; read-write and all include it", async () => {
  const readOnly = await Effect.runPromise(names("read-only"))
  const execute = await Effect.runPromise(names("execute"))
  const readWrite = await Effect.runPromise(names("read-write"))
  const all = await Effect.runPromise(names("all"))
  expect(readOnly).not.toContain("memory_add_note")
  expect(execute).not.toContain("memory_add_note")
  expect(readWrite).toContain("memory_add_note")
  expect(all).toContain("memory_add_note")
  expect(readOnly).toContain("memory_read")
})

test("websearch advertise respects webSearchEnabled", async () => {
  const namesFor = (providerID: string) =>
    withRegistry((registry) =>
      registry.materialize({ providerID, capability: "all" }).pipe(Effect.map((item) => item.definitions.map((tool) => tool.name))),
    )
  const opencode = await Effect.runPromise(namesFor("opencode"))
  const anthropic = await Effect.runPromise(namesFor("anthropic"))
  expect(opencode).toContain("websearch")
  expect(anthropic).not.toContain("websearch")
})

test("deny-star permission hides the tool from materialize", async () => {
  const result = await Effect.runPromise(
    withRegistry((registry) =>
      toolDefinitions(registry, [{ action: "bash", resource: "*", effect: "deny" }]).pipe(
        Effect.map((definitions) => definitions.map((tool) => tool.name)),
      ),
    ),
  )
  expect(result).not.toContain("bash")
  expect(result).toContain("read")
})

test("lsp is hidden unless OPENCODE_EXPERIMENTAL_LSP_TOOL is on", async () => {
  const off = await Effect.runPromise(
    withRegistry((registry) => toolDefinitions(registry).pipe(Effect.map((d) => d.map((t) => t.name)))),
  )
  expect(off).not.toContain("lsp")

  const previous = process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL
  process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL = "true"
  try {
    const on = await Effect.runPromise(
      withRegistry((registry) => toolDefinitions(registry).pipe(Effect.map((d) => d.map((t) => t.name)))),
    )
    expect(on).toContain("lsp")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL
    else process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL = previous
  }
})
