import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function metadata(part: ToolPart): Record<string, unknown> {
  if (part.state.status === "pending") return {}
  return (part.state as { metadata?: Record<string, unknown> }).metadata ?? {}
}

function policy(_cfg: DisplayConfig): DisplayPolicy {
  return { streaming: "collapsed", finished: "collapsed", error: "truncated", foldable: true }
}

function header(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  const icon = part.state.status === "completed" ? "\u2713" : "\u2502"
  return {
    verb: "execute",
    icon,
    family: "task",
    primary: "execute",
    details: "",
    muted: false,
    status: part.state.status,
    accent: "task",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const meta = metadata(part)
  const toolCalls = meta.toolCalls
  if (!Array.isArray(toolCalls)) return { kind: "none" }
  const lines = toolCalls.flatMap((call) => {
    if (call == null || typeof call !== "object") return []
    const c = call as Record<string, unknown>
    const tool = str(c.tool) ?? "unknown"
    const status = str(c.status) ?? ""
    return [`\u21B3 ${tool}${status === "error" ? " (failed)" : ""}`]
  })
  if (lines.length === 0) return { kind: "none" }
  return { kind: "lines", lines }
}

export const executeDescriptor: ToolDescriptor = {
  names: ["execute"],
  family: "task",
  policy,
  header,
  body,
}
