import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"
import { inputOf, matchCountFromMeta, metadataOf, readBodyFromMeta, str, toolOutputText } from "./shared"

function policy(_cfg: DisplayConfig): DisplayPolicy {
  return {
    streaming: "collapsed",
    finished: "collapsed",
    error: "collapsed",
    foldable: true,
    foldCycle: "two",
  }
}

function header(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  const inp = inputOf(part)
  const meta = metadataOf(part)
  const pattern = str(inp.pattern) ?? ""
  const output = toolOutputText(part)
  const matches = matchCountFromMeta(meta, output)
  const details = matches != null ? `(${matches} ${matches === 1 ? "match" : "matches"})` : ""
  return {
    verb: "Grep",
    icon: "\u2731",
    family: "search",
    primary: pattern ? `"${pattern}"` : "",
    details,
    muted: false,
    status: part.state.status,
    accent: "search",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }

  const output = toolOutputText(part)
  if (output.trim()) {
    return { kind: "lines", lines: output.trim().split("\n"), maxLines: 50 }
  }

  // When array structured was wrapped as { value: Match[] }
  const fromMeta = readBodyFromMeta(metadataOf(part))
  if (fromMeta?.kind === "lines") {
    return { kind: "lines", lines: fromMeta.lines, maxLines: 50 }
  }

  return { kind: "none" }
}

export const grepDescriptor: ToolDescriptor = {
  names: ["grep"],
  family: "search",
  policy,
  header,
  body,
}
