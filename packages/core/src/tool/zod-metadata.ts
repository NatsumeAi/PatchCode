export * as ZodMetadata from "./zod-metadata"

import type { ZodType } from "zod"
import { z } from "zod"

function isZodType(value: unknown): value is ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

/** Official leftover registry.ts zodMetadataRegistry: keep plugin Zod .meta() / .description. */
export function zodMetadataRegistry(schema: ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)
    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }
    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

export function toJsonSchema(schema: ZodType): Record<string, unknown> {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs } : rest
}
