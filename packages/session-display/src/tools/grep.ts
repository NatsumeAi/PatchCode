import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function input(part: ToolPart): Record<string, unknown> {
  return part.state.input ?? {}
}

function metadata(part: ToolPart): Record<string, unknown> {
  if (part.state.status === "pending") return {}
  return (part.state as { metadata?: Record<string, unknown> }).metadata ?? {}
}

function policy(_cfg: DisplayConfig): DisplayPolicy {
  return { streaming: "collapsed", finished: "collapsed", error: "collapsed", foldable: false }
}

function header(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  const inp = input(part)
  const meta = metadata(part)
  const pattern = str(inp.pattern) ?? ""
  const matches = num(meta.matches)
  const details = matches != null ? `(${matches} ${matches === 1 ? "match" : "matches"})` : ""
  return {
    verb: "Grep",
    icon: "\u2731",
    family: "search",
    primary: `"${pattern}"`,
    details,
    muted: false,
    status: part.state.status,
    accent: "search",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const output = part.state.status === "completed" ? part.state.output : ""
  if (!output.trim()) return { kind: "none" }
  const lines = output.trim().split("\n")
  return { kind: "lines", lines, maxLines: 50 }
}

export const grepDescriptor: ToolDescriptor = {
  names: ["grep"],
  family: "search",
  policy,
  header,
  body,
}
