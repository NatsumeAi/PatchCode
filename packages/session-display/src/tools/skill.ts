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

function header(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  const inp = input(part)
  const name = str(inp.name) ?? "skill"
  return {
    verb: "Skill",
    icon: "\u2192",
    family: "skill",
    primary: name,
    details: "",
    muted: false,
    status: part.state.status,
    accent: "skill",
  }
}

function body(_part: ToolPart, _mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  return { kind: "none" }
}

export const skillDescriptor: ToolDescriptor = {
  names: ["skill"],
  family: "skill",
  policy,
  header,
  body,
}
