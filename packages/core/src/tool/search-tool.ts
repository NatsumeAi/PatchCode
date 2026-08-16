export * as SearchTool from "./search-tool"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = ToolRegistry.SEARCH_TOOL

const Input = Schema.Struct({
  query: Schema.String.annotate({ description: "Substring to match against MCP/dynamic tool names and descriptions" }),
})

const Hit = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  server: Schema.String,
})

const Output = Schema.Struct({
  results: Schema.Array(Hit),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Search deferred MCP/dynamic tools by name or description. Use the returned name with use_tool.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output.results) }],
          execute: (input) =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              const results = yield* registry.searchDynamic(input.query)
              return { results }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: String(error) }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/search-tool",
  layer,
  deps: [ToolRegistry.node],
})
