import type { ToolPart } from "@opencode-ai/sdk/api"
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

function policy(_cfg: DisplayConfig): DisplayPolicy {
  return { streaming: "collapsed", finished: "collapsed", error: "truncated", foldable: true }
}

function headerLabel(part: ToolPart): string {
  const keys = ["description", "query", "url", "filePath", "path", "pattern", "name"]
  const inp = input(part)
  for (const key of keys) {
    const value = inp[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return ""
}

function header(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  return {
    verb: part.tool,
    icon: "\u2699",
    family: "generic",
    primary: truncateText(headerLabel(part), 60),
    details: "",
    muted: false,
    status: part.state.status,
    accent: "generic",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const output = part.state.status === "completed" ? part.state.output : ""
  if (!output.trim()) {
    if (part.state.status === "error") {
      const errorText = (part.state as { error?: string }).error ?? ""
      if (errorText) return { kind: "text", text: errorText }
    }
    return { kind: "none" }
  }
  return { kind: "text", text: output, maxLines: 10 }
}

export const genericDescriptor: ToolDescriptor = {
  names: [],
  family: "generic",
  policy,
  header,
  body,
}
