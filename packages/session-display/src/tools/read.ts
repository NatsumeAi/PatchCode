import type { ToolPart } from "@opencode-ai/sdk/api"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"
import { inputOf, metadataOf, readBodyFromMeta, toolOutputText, toolPath } from "./shared"

function policy(_cfg: DisplayConfig): DisplayPolicy {
  return {
    streaming: "collapsed",
    finished: "collapsed",
    error: "collapsed",
    foldable: true,
    foldCycle: "three",
  }
}

function header(part: ToolPart, ctx: DisplayContext): HeaderModel {
  const path = toolPath(inputOf(part))
  return {
    verb: "Read",
    icon: "\u2192",
    family: "read",
    primary: path ? ctx.formatPath(path) : "",
    details: "",
    muted: false,
    status: part.state.status,
    accent: "read",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }

  const meta = metadataOf(part)
  const maxLines = mode === "truncated" ? 8 : undefined

  // Prefer model-facing text when present (grep-style output or explicit content parts).
  const output = toolOutputText(part)
  if (output.trim()) {
    return { kind: "text", text: output, maxLines }
  }

  // Structured read result (Content / TextPage / ListPage) lives in metadata via tool.success bridge.
  const fromMeta = readBodyFromMeta(meta)
  if (fromMeta?.kind === "text") {
    return { kind: "text", text: fromMeta.text, maxLines }
  }
  if (fromMeta?.kind === "lines") {
    return { kind: "lines", lines: fromMeta.lines, maxLines: maxLines ?? 50 }
  }

  const path = toolPath(inputOf(part))
  if (path) return { kind: "lines", lines: [`Read ${path}`] }
  return { kind: "none" }
}

export const readDescriptor: ToolDescriptor = {
  names: ["read"],
  family: "read",
  policy,
  header,
  body,
}
