import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function input(part: ToolPart): Record<string, unknown> {
  return part.state.input ?? {}
}

function policy(_cfg: DisplayConfig): DisplayPolicy {
  return { streaming: "collapsed", finished: "collapsed", error: "collapsed", foldable: false }
}

function header(part: ToolPart, ctx: DisplayContext): HeaderModel {
  const inp = input(part)
  const path = str(inp.path) ?? "/"
  return {
    verb: "List",
    icon: "\u2022",
    family: "search",
    primary: ctx.formatPath(path),
    details: "",
    muted: false,
    status: part.state.status,
    accent: "search",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const output = part.state.status === "completed" ? part.state.output : ""
  if (!output.trim()) return { kind: "none" }
  return { kind: "lines", lines: output.trim().split("\n") }
}

export const listDescriptor: ToolDescriptor = {
  names: ["list"],
  family: "search",
  policy,
  header,
  body,
}
