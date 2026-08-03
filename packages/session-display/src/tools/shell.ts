import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"
import { truncateText } from "../header-utils"

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function input(part: ToolPart): Record<string, unknown> {
  return part.state.input ?? {}
}

function metadata(part: ToolPart): Record<string, unknown> {
  if (part.state.status === "pending") return {}
  // running may carry progress metadata.output; completed/error too
  return (part.state as { metadata?: Record<string, unknown> }).metadata ?? {}
}

function policy(cfg: DisplayConfig): DisplayPolicy {
  return {
    streaming: "collapsed",
    finished: "collapsed",
    error: "truncated",
    foldable: true,
    truncatedLines: cfg.shellErrorTruncatedLines,
  }
}

function header(part: ToolPart, _ctx: DisplayContext): HeaderModel {
  const inp = input(part)
  const description = str(inp.description)
  const command = str(inp.command) ?? ""
  const primary = description || truncateText(command, 60)
  return {
    verb: "",
    icon: "$",
    family: "shell",
    primary,
    details: "",
    muted: false,
    status: part.state.status,
    accent: "shell",
  }
}

/** Prefer metadata.output (V1 projector); fall back to state.output (V2 bridge). */
function shellOutput(part: ToolPart): string {
  const meta = metadata(part)
  const fromMeta = str(meta.output)
  if (fromMeta) return fromMeta
  if (part.state.status === "completed" || part.state.status === "error") {
    const fromState = str((part.state as { output?: unknown }).output)
    if (fromState) return fromState
  }
  return ""
}

function body(part: ToolPart, mode: DisplayMode, ctx: DisplayContext): BodyModel {
  const output = shellOutput(part)

  // §4: shell success → body none while collapsed; expanded reveals output
  if (part.state.status === "completed" && !isLogicalError(part)) {
    if (mode === "collapsed") return { kind: "none" }
    const lines = output.trim().split("\n").filter((l) => l.length > 0)
    if (lines.length === 0) return { kind: "none" }
    return { kind: "lines", lines }
  }

  // Running with progress: expanded shows live tail
  if ((part.state.status === "running" || part.state.status === "pending") && mode !== "collapsed") {
    const lines = output.trim().split("\n").filter((l) => l.length > 0)
    if (lines.length === 0) return { kind: "none" }
    return { kind: "lines", lines, maxLines: 30 }
  }

  // error / logicalError → truncated tail
  if (mode === "collapsed") return { kind: "none" }

  const errorText = part.state.status === "error" ? (part.state as { error?: string }).error ?? "" : ""
  const lines: string[] = []
  if (errorText) lines.push(errorText)
  if (output.trim()) {
    const outputLines = output.trim().split("\n")
    const maxLines = ctx.config.shellErrorTruncatedLines
    const tail = outputLines.slice(-maxLines)
    lines.push(...tail)
  }
  if (lines.length === 0) return { kind: "none" }
  return { kind: "lines", lines, maxLines: ctx.config.shellErrorTruncatedLines }
}

function isLogicalError(part: ToolPart): boolean {
  const meta = metadata(part)
  const exit = meta.exit
  if (typeof exit === "number" && exit !== 0) return true
  if (meta.timeout === true) return true
  return false
}

export const shellDescriptor: ToolDescriptor = {
  names: ["shell", "bash"],
  family: "shell",
  policy,
  header,
  body,
  logicalError: isLogicalError,
}
