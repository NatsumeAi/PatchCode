import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { DisplayContext, ToolDescriptor } from "../registry"
import type { BodyModel, DisplayMode, DisplayPolicy, HeaderModel } from "../mode"
import type { DisplayConfig } from "../config"
import { inputOf, metadataOf, str, toolOutputText } from "./shared"

interface PatchFile {
  path: string
  diff: string
  type: string
}

/**
 * Runtime apply_patch structured files: FileDiff.Info { file, patch, status, additions, deletions }.
 * Older shapes may use relativePath/filePath/type.
 */
function parsePatchFiles(meta: Record<string, unknown>): PatchFile[] {
  const raw = meta.files
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (item == null || typeof item !== "object") return []
    const f = item as Record<string, unknown>
    const path =
      str(f.file) ?? str(f.relativePath) ?? str(f.filePath) ?? str(f.resource) ?? str(f.target) ?? ""
    const patch = str(f.patch)
    if (!path || patch === undefined) return []
    const type = str(f.status) ?? str(f.type) ?? "modified"
    return [{ path, diff: patch, type }]
  })
}

function policy(cfg: DisplayConfig): DisplayPolicy {
  if (cfg.collapsedEditBlocks) {
    return { streaming: "collapsed", finished: "collapsed", error: "collapsed", foldable: true }
  }
  return { streaming: "collapsed", finished: "expanded", error: "collapsed", foldable: true }
}

function header(part: ToolPart, ctx: DisplayContext): HeaderModel {
  const meta = metadataOf(part)
  const files = parsePatchFiles(meta)
  const primary =
    files.length === 0
      ? ""
      : files.length === 1
        ? ctx.formatPath(files[0]!.path)
        : `${files.length} files`
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
  const meta = metadataOf(part)
  const files = parsePatchFiles(meta)
  if (files.length > 0) return { kind: "patch", files }

  const output = toolOutputText(part)
  if (output.trim()) return { kind: "text", text: output }

  if (part.state.status === "error") {
    const errorText = (part.state as { error?: string }).error ?? ""
    if (errorText) return { kind: "text", text: errorText }
  }
  return { kind: "none" }
}

export const patchDescriptor: ToolDescriptor = {
  names: ["patch", "apply_patch"],
  family: "edit",
  policy,
  header,
  body,
}
