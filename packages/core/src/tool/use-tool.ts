export * as UseTool from "./use-tool"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = ToolRegistry.USE_TOOL

const Input = Schema.Struct({
  name: Schema.String.annotate({ description: "Registered MCP/dynamic tool name from search_tool" }),
  input: Schema.Unknown.pipe(Schema.optional).annotate({ description: "Arguments for the inner tool" }),
})

const Output = Schema.Struct({
  name: Schema.String,
  output: Schema.Unknown,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Execute a deferred MCP/dynamic tool by its real registered name. Prefer search_tool to discover names.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: typeof output.output === "string" ? output.output : JSON.stringify(output.output) },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              if (input.name === ToolRegistry.USE_TOOL || input.name === ToolRegistry.SEARCH_TOOL) {
                return yield* new ToolFailure({ message: "use_tool cannot target search_tool or use_tool" })
              }
              const registry = yield* ToolRegistry.Service
              const materialized = yield* registry.materialize()
              const settlement = yield* materialized.settle({
                sessionID: context.sessionID,
                agent: context.agent,
                assistantMessageID: context.assistantMessageID,
                call: {
                  type: "tool-call",
                  id: context.toolCallID,
                  name: input.name,
                  input: input.input ?? {},
                },
              })
              if (settlement.result.type === "error") {
                const value = String(settlement.result.value)
                const message = value.startsWith("Unknown tool:")
                  ? `${value}. Use search_tool to find available tools.`
                  : value
                return yield* new ToolFailure({ message })
              }
              return { name: input.name, output: settlement.result.value }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/use-tool",
  layer,
  deps: [ToolRegistry.node],
})
