export * as StructuredOutput from "./structured-output"

import { ToolDefinition } from "@opencode-ai/llm"
import { Effect } from "effect"
import type { ToolRegistry } from "./registry"

export const name = "StructuredOutput"

export const DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const captured = new Map<string, unknown>()

export const take = (sessionID: string) => {
  const value = captured.get(sessionID)
  captured.delete(sessionID)
  return value
}

export const peek = (sessionID: string) => captured.get(sessionID)

export const clear = (sessionID: string) => {
  captured.delete(sessionID)
}

export const wrap = (
  materialized: ToolRegistry.Materialization,
  format: { readonly type: string; readonly schema?: Record<string, unknown> } | undefined,
  sessionID: string,
): ToolRegistry.Materialization => {
  if (!format || format.type !== "json_schema" || !format.schema) return materialized
  const { $schema: _, ...schema } = format.schema
  const extra = new ToolDefinition({
    name,
    description: DESCRIPTION,
    inputSchema: schema,
  })
  return {
    definitions: [...materialized.definitions, extra],
    settle: (input) => {
      if (input.call.name === name || input.call.name.toLowerCase() === name.toLowerCase()) {
        captured.set(sessionID, input.call.input)
        return Effect.succeed({
          result: { type: "text" as const, value: "Structured output captured successfully." },
        })
      }
      return materialized.settle(input)
    },
    hidden: materialized.hidden,
  }
}
