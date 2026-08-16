export * as InvalidTool from "./invalid"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "invalid"

export const Input = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

export const Output = Schema.Struct({
  output: Schema.String,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => [{ type: "text" as const, text: output.output }]

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description: "Do not use",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => toModelOutput(output),
          execute: (input) =>
            Effect.succeed({
              output: `The arguments provided to the tool are invalid: ${input.error}`,
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/invalid",
  layer,
  deps: [ToolRegistry.node],
})
