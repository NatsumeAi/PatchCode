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

function policy(cfg: DisplayConfig): DisplayPolicy {
  // §4: edit with diff → finished expanded; collapsedEditBlocks opt-in collapses
  if (cfg.collapsedEditBlocks) {
    return { streaming: "collapsed", finished: "collapsed", error: "collapsed", foldable: true }
  }
  return { streaming: "collapsed", finished: "expanded", error: "collapsed", foldable: true }
}

function header(part: ToolPart, ctx: DisplayContext): HeaderModel {
  const inp = input(part)
  const filePath = str(inp.filePath) ?? ""
  return {
    verb: "Edit",
    icon: "\u2190",
    family: "edit",
    primary: filePath ? ctx.formatPath(filePath) : "",
    details: "",
    muted: false,
    status: part.state.status,
    accent: "edit",
  }
}

function hasDiff(part: ToolPart): boolean {
  const meta = metadata(part)
  return str(meta.diff) != null || meta.filediff != null
}

function body(part: ToolPart, mode: DisplayMode, ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const meta = metadata(part)
  const filePath = str(input(part).filePath) ?? ""

  // filediff (structured) takes priority for web; TUI uses meta.diff string
  const diff = str(meta.diff)
  if (diff) return { kind: "diff", diff, path: filePath, maxLines: ctx.config.diffMaxLines }

  const filediff = record(meta.filediff)
  const patch = filediff ? str(filediff.patch) : undefined
  if (patch) return { kind: "diff", diff: patch, path: str(filediff?.file) ?? filePath, maxLines: ctx.config.diffMaxLines }

  // If no diff metadata but expanded (e.g. error detail), show error text
  if (part.state.status === "error") {
    const errorText = (part.state as { error?: string }).error ?? ""
    if (errorText) return { kind: "text", text: errorText }
  }

  return { kind: "none" }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

export const editDescriptor: ToolDescriptor = {
  names: ["edit"],
  family: "edit",
  policy,
  header,
  body,
}
