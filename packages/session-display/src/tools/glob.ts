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
  const count = num(meta.count)
  const details = count != null ? `(${count} ${count === 1 ? "match" : "matches"})` : ""
  return {
    verb: "Glob",
    icon: "\u2731",
    family: "search",
    primary: `"${pattern}"`,
    details,
    muted: false,
    status: part.state.status,
    accent: "search",
  }
}

function body(_part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  return { kind: "none" }
}

export const globDescriptor: ToolDescriptor = {
  names: ["glob"],
  family: "search",
  policy,
  header,
  body,
}
