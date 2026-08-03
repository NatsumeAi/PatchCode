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

function policy(cfg: DisplayConfig): DisplayPolicy {
  // §4: write with content → finished expanded (same as edit)
  if (cfg.collapsedEditBlocks) {
    return { streaming: "collapsed", finished: "collapsed", error: "collapsed", foldable: true }
  }
  return { streaming: "collapsed", finished: "expanded", error: "collapsed", foldable: true }
}

function header(part: ToolPart, ctx: DisplayContext): HeaderModel {
  const inp = input(part)
  const filePath = str(inp.filePath) ?? ""
  return {
    verb: "Write",
    icon: "\u2190",
    family: "write",
    primary: filePath ? ctx.formatPath(filePath) : "",
    details: "",
    muted: false,
    status: part.state.status,
    accent: "write",
  }
}

function hasContent(part: ToolPart): boolean {
  const content = str(input(part).content)
  return content != null && content.length > 0
}

function body(part: ToolPart, mode: DisplayMode, ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const content = str(input(part).content)
  const filePath = str(input(part).filePath) ?? ""
  if (content) return { kind: "code", content, path: filePath, maxLines: ctx.config.diffMaxLines }
  if (part.state.status === "error") {
    const errorText = (part.state as { error?: string }).error ?? ""
    if (errorText) return { kind: "text", text: errorText }
  }
  return { kind: "none" }
}

export const writeDescriptor: ToolDescriptor = {
  names: ["write"],
  family: "write",
  policy,
  header,
  body,
}
