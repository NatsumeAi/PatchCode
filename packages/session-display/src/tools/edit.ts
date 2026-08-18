import type { ToolPart } from "@opencode-ai/sdk/api"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"
import { inputOf, metadataOf, toolDiffFromMeta, toolOutputText, toolPath } from "./shared"

function policy(cfg: DisplayConfig): DisplayPolicy {
  if (cfg.collapsedEditBlocks) {
    return { streaming: "collapsed", finished: "collapsed", error: "collapsed", foldable: true }
  }
  return { streaming: "collapsed", finished: "expanded", error: "collapsed", foldable: true }
}

function header(part: ToolPart, ctx: DisplayContext): HeaderModel {
  const path = toolPath(inputOf(part))
  return {
    verb: "Edit",
    icon: "\u2190",
    family: "edit",
    primary: path ? ctx.formatPath(path) : "",
    details: "",
    muted: false,
    status: part.state.status,
    accent: "edit",
  }
}

function body(part: ToolPart, mode: DisplayMode, ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }

  const meta = metadataOf(part)
  const path = toolPath(inputOf(part))
  const found = toolDiffFromMeta(meta, path)
  if (found) {
    return { kind: "diff", diff: found.diff, path: found.path, maxLines: ctx.config.diffMaxLines }
  }

  // Fallback: model text preview (```diff block from toModelOutput)
  const output = toolOutputText(part)
  if (output.trim()) return { kind: "text", text: output, maxLines: ctx.config.diffMaxLines }

  if (part.state.status === "error") {
    const errorText = (part.state as { error?: string }).error ?? ""
    if (errorText) return { kind: "text", text: errorText }
  }

  return { kind: "none" }
}

export const editDescriptor: ToolDescriptor = {
  names: ["edit"],
  family: "edit",
  policy,
  header,
  body,
}
