import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"
import { inputOf, str, toolOutputText, toolPath } from "./shared"

function policy(cfg: DisplayConfig): DisplayPolicy {
  if (cfg.collapsedEditBlocks) {
    return { streaming: "collapsed", finished: "collapsed", error: "collapsed", foldable: true }
  }
  return { streaming: "collapsed", finished: "expanded", error: "collapsed", foldable: true }
}

function header(part: ToolPart, ctx: DisplayContext): HeaderModel {
  const path = toolPath(inputOf(part))
  return {
    verb: "Write",
    icon: "\u2190",
    family: "write",
    primary: path ? ctx.formatPath(path) : "",
    details: "",
    muted: false,
    status: part.state.status,
    accent: "write",
  }
}

function body(part: ToolPart, mode: DisplayMode, ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }

  const inp = inputOf(part)
  const content = str(inp.content)
  const path = toolPath(inp)
  if (content) return { kind: "code", content, path, maxLines: ctx.config.diffMaxLines }

  const output = toolOutputText(part)
  if (output.trim()) return { kind: "text", text: output, maxLines: ctx.config.diffMaxLines }

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
