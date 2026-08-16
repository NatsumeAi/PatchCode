export * as ToolJsonSchema from "./json-schema"

import { JsonSchema, Schema } from "effect"

const MIN_SAFE = Number.MIN_SAFE_INTEGER
const MAX_SAFE = Number.MAX_SAFE_INTEGER
const SCHEMA_URI = "https://json-schema.org/draft/2020-12/schema"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNullSchema(value: unknown) {
  return isRecord(value) && value.type === "null"
}

function resolveRef(ref: string, defs: Record<string, unknown>) {
  const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/)
  if (!match?.[1]) return undefined
  return defs[decodeURIComponent(match[1])]
}

function unwrapOptionalNull(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.anyOf)) return value
  const variants = value.anyOf.filter((item) => !isNullSchema(item))
  if (variants.length !== value.anyOf.length - 1 || variants.length === 0) return value
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "anyOf"))
  if (variants.length === 1 && isRecord(variants[0])) return { ...variants[0], ...rest }
  return { ...rest, anyOf: variants }
}

const NUMERIC_KEYS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "description"])

function flattenNumericAllOf(schema: Record<string, unknown>) {
  if ((schema.type !== "integer" && schema.type !== "number") || !Array.isArray(schema.allOf)) return schema
  const merged: Record<string, unknown> = { ...schema }
  const leftover: unknown[] = []
  for (const item of schema.allOf) {
    if (!isRecord(item)) {
      leftover.push(item)
      continue
    }
    if (!Object.keys(item).every((key) => NUMERIC_KEYS.has(key))) {
      leftover.push(item)
      continue
    }
    Object.assign(merged, item)
  }
  if (leftover.length) merged.allOf = leftover
  else delete merged.allOf
  return merged
}

function isSpecialNumberVariant(value: unknown) {
  return (
    isRecord(value) &&
    value.type === "string" &&
    Array.isArray(value.enum) &&
    value.enum.every((item) => item === "NaN" || item === "Infinity" || item === "-Infinity")
  )
}

function unwrapNumberJson(schema: Record<string, unknown>) {
  if (!Array.isArray(schema.anyOf)) return schema
  const numbers = schema.anyOf.filter((item) => isRecord(item) && item.type === "number")
  const specials = schema.anyOf.filter(isSpecialNumberVariant)
  if (numbers.length !== 1 || numbers.length + specials.length !== schema.anyOf.length) return schema
  const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "anyOf"))
  return { type: "number", ...numbers[0], ...rest }
}

function emptyStruct(schema: Record<string, unknown>) {
  if (!Array.isArray(schema.anyOf)) return schema
  const onlyObjectArray =
    schema.anyOf.length === 2 &&
    schema.anyOf.some((item) => isRecord(item) && item.type === "object" && Object.keys(item).length === 1) &&
    schema.anyOf.some((item) => isRecord(item) && item.type === "array" && Object.keys(item).length === 1)
  if (!onlyObjectArray) return schema
  const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "anyOf"))
  return { type: "object", properties: {}, ...rest }
}

function boundInteger(schema: Record<string, unknown>) {
  let next = emptyStruct(schema)
  next = unwrapNumberJson(next)
  next = flattenNumericAllOf(next)
  if (next.type !== "integer") return next
  const hasMax = typeof next.maximum === "number" || typeof next.exclusiveMaximum === "number"
  const maximum = hasMax ? next.maximum : MAX_SAFE
  const customMax = typeof maximum === "number" && maximum !== MAX_SAFE
  const hasMin = typeof next.minimum === "number"
  const minimum =
    hasMin || (typeof next.exclusiveMinimum === "number" && customMax) ? next.minimum : MIN_SAFE
  return {
    ...next,
    ...(typeof minimum === "number" ? { minimum } : {}),
    ...(hasMax ? {} : { maximum: MAX_SAFE }),
  }
}

function walk(value: unknown, defs: Record<string, unknown>, stack: Set<unknown>, optional = false): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item, defs, stack))
  if (!isRecord(value)) return value
  if (typeof value.$ref === "string") {
    const resolved = resolveRef(value.$ref, defs)
    if (resolved !== undefined) {
      if (stack.has(resolved)) return value
      stack.add(resolved)
      const extra = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"))
      const inlined = walk(resolved, defs, stack, optional)
      stack.delete(resolved)
      const merged = isRecord(inlined) ? { ...inlined, ...(walk(extra, defs, stack, optional) as object) } : inlined
      return optional && isRecord(merged) ? unwrapOptionalNull(merged) : merged
    }
  }
  const out: Record<string, unknown> = {}
  const required = new Set(Array.isArray(value.required) ? value.required.filter((item) => typeof item === "string") : [])
  for (const [key, item] of Object.entries(value)) {
    if (key === "$defs" || key === "definitions" || key === "additionalProperties") continue
    if (key === "properties" && isRecord(item)) {
      out.properties = Object.fromEntries(
        Object.entries(item).map(([name, prop]) => [name, walk(prop, defs, stack, !required.has(name))]),
      )
      continue
    }
    out[key] = walk(item, defs, stack)
  }
  const next = optional ? unwrapOptionalNull(out) : out
  return isRecord(next) ? boundInteger(next) : next
}

/** Provider-facing JSON Schema: leftover ToolJsonSchema.fromSchema extras. */
export function fromSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema, { additionalProperties: true })
  const defs = { ...document.definitions }
  const raw = Object.keys(defs).length === 0 ? document.schema : { ...document.schema, $defs: defs }
  const walked = walk(raw, defs, new Set())
  return {
    $schema: SCHEMA_URI,
    ...(isRecord(walked) ? walked : { type: "object" }),
  } as JsonSchema.JsonSchema
}
