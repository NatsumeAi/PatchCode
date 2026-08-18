import type { ToolPart } from "@opencode-ai/sdk/api"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"

function input(part: ToolPart): Record<string, unknown> {
  return part.state.input ?? {}
}

function metadata(part: ToolPart): Record<string, unknown> {
  if (part.state.status === "pending") return {}
  return (part.state as { metadata?: Record<string, unknown> }).metadata ?? {}
}

interface TodoItem {
  status: string
  content: string
}

function parseTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (item == null || typeof item !== "object") return []
    const todo = item as Record<string, unknown>
    const status = typeof todo.status === "string" ? todo.status : undefined
    const content = typeof todo.content === "string" ? todo.content : undefined
    if (!status || !content) return []
    return [{ status, content }]
  })
}

function policy(_cfg: DisplayConfig): DisplayPolicy {
  return { streaming: "collapsed", finished: "collapsed", error: "collapsed", foldable: true }
}

function header(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  const meta = metadata(part)
  const todos = parseTodos(meta.todos ?? input(part).todos)
  const done = todos.filter((t) => t.status === "completed").length
  const details = todos.length > 0 ? `${done}/${todos.length}` : ""
  return {
    verb: "Todos",
    icon: "\u2699",
    family: "todo",
    primary: "",
    details,
    muted: false,
    status: part.state.status,
    accent: "todo",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const meta = metadata(part)
  const todos = parseTodos(meta.todos ?? input(part).todos)
  if (todos.length === 0) return { kind: "none" }
  return { kind: "todos", items: todos }
}

export const todoDescriptor: ToolDescriptor = {
  names: ["todowrite"],
  family: "todo",
  policy,
  header,
  body,
}
