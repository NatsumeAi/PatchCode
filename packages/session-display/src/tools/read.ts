import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"
import { filename } from "../header-utils"

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function input(part: ToolPart): Record<string, unknown> {
  return part.state.input ?? {}
}

function metadata(part: ToolPart): Record<string, unknown> {
  if (part.state.status === "pending") return {}
  return (part.state as { metadata?: Record<string, unknown> }).metadata ?? {}
}

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
  const inp = input(part)
  const filePath = str(inp.filePath) ?? ""
  const meta = metadata(part)
  const loaded = Array.isArray(meta.loaded) ? (meta.loaded as string[]).filter((x) => typeof x === "string") : []
  const details = loaded.length > 0 ? `+${loaded.length} loaded` : ""
  return {
    verb: "Read",
    icon: "\u2192",
    family: "read",
    primary: filePath ? ctx.formatPath(filePath) : "",
    details,
    muted: false,
    status: part.state.status,
    accent: "read",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  // §4: read collapsed body = none (no default Loaded lines)
  if (mode === "collapsed") return { kind: "none" }
  // expanded: optionally show loaded list
  const meta = metadata(part)
  const loaded = Array.isArray(meta.loaded) ? (meta.loaded as string[]).filter((x) => typeof x === "string") : []
  if (loaded.length === 0) return { kind: "none" }
  return { kind: "lines", lines: loaded.map((p) => `Loaded ${p}`) }
}

export const readDescriptor: ToolDescriptor = {
  names: ["read"],
  family: "read",
  policy,
  header,
  body,
}
