import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"
import { truncateText } from "../header-utils"

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function input(part: ToolPart): Record<string, unknown> {
  return part.state.input ?? {}
}

function metadata(part: ToolPart): Record<string, unknown> {
  if (part.state.status === "pending") return {}
  return (part.state as { metadata?: Record<string, unknown> }).metadata ?? {}
}

function policy(_cfg: DisplayConfig): DisplayPolicy {
  return { streaming: "collapsed", finished: "collapsed", error: "truncated", foldable: true }
}

function header(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  const inp = input(part)
  const description = str(inp.description) ?? ""
  const subagentType = str(inp.subagent_type)
  const verb = subagentType ? `${subagentType[0].toUpperCase()}${subagentType.slice(1)} Task` : "Task"
  const icon = part.state.status === "completed" ? "\u2713" : "\u2502"
  return {
    verb,
    icon,
    family: "task",
    primary: truncateText(description, 60),
    details: "",
    muted: false,
    status: part.state.status,
    accent: "task",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  // expanded: show sub-progress lines if available
  const output = part.state.status === "completed" ? part.state.output : ""
  if (!output.trim()) return { kind: "none" }
  return { kind: "lines", lines: output.trim().split("\n").slice(0, 20) }
}

export const taskDescriptor: ToolDescriptor = {
  names: ["task"],
  family: "task",
  policy,
  header,
  body,
}
