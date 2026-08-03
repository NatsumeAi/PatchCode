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

interface PatchFile {
  path: string
  diff: string
  type: string
}

function parsePatchFiles(meta: Record<string, unknown>): PatchFile[] {
  const raw = meta.files
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (item == null || typeof item !== "object") return []
    const f = item as Record<string, unknown>
    const relativePath = str(f.relativePath)
    const filePath = str(f.filePath)
    const patch = str(f.patch)
    const type = str(f.type) ?? "edit"
    if (!relativePath || patch === undefined) return []
    return [{ path: relativePath, diff: patch, type }]
  })
}

function policy(cfg: DisplayConfig): DisplayPolicy {
  if (cfg.collapsedEditBlocks) {
    return { streaming: "collapsed", finished: "collapsed", error: "collapsed", foldable: true }
  }
  return { streaming: "collapsed", finished: "expanded", error: "collapsed", foldable: true }
}

function header(part: ToolPart, ctx: DisplayContext): HeaderModel {
  const meta = metadata(part)
  const files = parsePatchFiles(meta)
  const primary = files.length === 1 ? ctx.formatPath(files[0].path) : `${files.length} files`
  return {
    verb: "Patch",
    icon: "%",
    family: "edit",
    primary,
    details: "",
    muted: false,
    status: part.state.status,
    accent: "edit",
  }
}

function body(part: ToolPart, mode: DisplayMode, _ctx: DisplayContext): BodyModel {
  if (mode === "collapsed") return { kind: "none" }
  const meta = metadata(part)
  const files = parsePatchFiles(meta)
  if (files.length === 0) {
    if (part.state.status === "error") {
      const errorText = (part.state as { error?: string }).error ?? ""
      if (errorText) return { kind: "text", text: errorText }
    }
    return { kind: "none" }
  }
  return { kind: "patch", files }
}

export const patchDescriptor: ToolDescriptor = {
  names: ["patch"],
  family: "edit",
  policy,
  header,
  body,
}
