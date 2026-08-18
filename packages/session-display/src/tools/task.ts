import type { ToolPart } from "@opencode-ai/sdk/api"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"
import { inputOf, metadataOf, str, toolOutputText } from "./shared"
import { truncateText } from "../header-utils"

function policy(_cfg: DisplayConfig): DisplayPolicy {
  return { streaming: "collapsed", finished: "collapsed", error: "truncated", foldable: true }
}

function header(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  const inp = inputOf(part)
  const description = str(inp.description) ?? ""
  const subagentType = str(inp.subagent_type)
  const verb = subagentType ? `${subagentType[0]!.toUpperCase()}${subagentType.slice(1)} Task` : "Task"
  const icon = part.state.status === "completed" ? "\u2713" : "\u2502"
  const meta = metadataOf(part)
  const bg = meta.background === true || inp.background === true
  return {
    verb,
    icon,
    family: "task",
    primary: truncateText(description, 60),
    details: bg ? "background" : "",
    muted: false,
    status: part.state.status,
    accent: "task",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const output = toolOutputText(part)
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
