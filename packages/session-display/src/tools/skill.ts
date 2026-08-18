import type { ToolPart } from "@opencode-ai/sdk/api"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"
import { inputOf, metadataOf, str, toolOutputText } from "./shared"

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
  const name = str(inp.name) ?? str(meta.name) ?? "skill"
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

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const output = toolOutputText(part)
  if (output.trim()) return { kind: "text", text: output, maxLines: 40 }
  const meta = metadataOf(part)
  const fromMeta = str(meta.output)
  if (fromMeta?.trim()) return { kind: "text", text: fromMeta, maxLines: 40 }
  return { kind: "none" }
}

export const skillDescriptor: ToolDescriptor = {
  names: ["skill"],
  family: "skill",
  policy,
  header,
  body,
}
