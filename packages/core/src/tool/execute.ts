export * as ExecuteTool from "./execute"

import { CodeMode, Tool as SandboxTool, toolError } from "@opencode-ai/codemode"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = ToolRegistry.EXECUTE_TOOL

const DESCRIPTION = "Run a confined orchestration script with access to registered tools via `tools.<name>(input)`."

const Input = Schema.Struct({
  code: Schema.String.annotate({
    description: "Script body executed by the confined interpreter.",
  }),
})

const Output = Schema.Struct({
  output: Schema.String,
  toolCalls: Schema.Array(Schema.String),
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description: DESCRIPTION,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const registry = yield* ToolRegistry.Service
              const materialized = yield* registry.materialize()
              const tree: Record<string, SandboxTool.Definition> = {}
              let nested = 0
              const add = (toolName: string, description: string, inputSchema: SandboxTool.JsonSchema) => {
                if (
                  toolName === name ||
                  toolName === ToolRegistry.SEARCH_TOOL ||
                  toolName === ToolRegistry.USE_TOOL ||
                  tree[toolName]
                )
                  return
                tree[toolName] = SandboxTool.make({
                  description,
                  input: inputSchema,
                  run: (args) => {
                    nested += 1
                    return materialized
                      .settle({
                        sessionID: context.sessionID,
                        agent: context.agent,
                        assistantMessageID: context.assistantMessageID,
                        call: {
                          type: "tool-call",
                          id: `${context.toolCallID}/${nested}`,
                          name: toolName,
                          input: args ?? {},
                        },
                      })
                      .pipe(
                        Effect.flatMap((settlement) => {
                          if (settlement.result.type === "error") {
                            return Effect.fail(toolError(String(settlement.result.value)))
                          }
                          return Effect.succeed(settlement.result.value)
                        }),
                      )
                  },
                })
              }
              for (const def of materialized.definitions) {
                add(def.name, def.description ?? "", def.inputSchema as SandboxTool.JsonSchema)
              }
              for (const hit of yield* registry.searchDynamic("", 0)) {
                add(hit.name, hit.description, { type: "object" })
              }
              const runtime = CodeMode.make({
                tools: tree,
                limits: { timeoutMs: 30_000, maxToolCalls: 50, maxOutputBytes: 100_000 },
              })
              const result = yield* runtime.execute(input.code)
              const inner = result.toolCalls.map((call) => call.name)
              if (!result.ok) {
                return yield* new ToolFailure({ message: result.error.message })
              }
              const output =
                typeof result.value === "string"
                  ? result.value
                  : (JSON.stringify(result.value, null, 2) ?? String(result.value))
              return { output, toolCalls: inner }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/execute",
  layer,
  deps: [ToolRegistry.node],
})
