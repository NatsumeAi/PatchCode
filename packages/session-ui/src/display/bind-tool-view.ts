import {
  buildToolViewModel,
  DEFAULT_CONFIG,
  type DisplayConfig,
  type DisplayContext,
  type DisplayMode,
} from "@opencode-ai/session-display"
import type { ToolPart } from "@opencode-ai/sdk/api"

const webContext: DisplayContext = {
  cwd: "/",
  width: 120,
  config: DEFAULT_CONFIG,
  formatPath: (p) => p,
}

/**
 * Kernel-driven defaultOpen for the Web UI.
 * Replaces the hardcoded toolDefaultOpen/partDefaultOpen with §4 gold table policy.
 * User preferences (shellToolDefaultOpen, editToolDefaultOpen) are passed as pins.
 */
export function kernelDefaultOpen(
  part: ToolPart,
  opts?: { config?: DisplayConfig; shellPref?: boolean; editPref?: boolean },
): boolean {
  const pin = userPinForTool(part.tool, opts?.shellPref, opts?.editPref)
  const ctx = opts?.config ? { ...webContext, config: opts.config } : webContext
  const vm = buildToolViewModel(part, ctx, pin)
  return vm.mode !== "collapsed"
}

function userPinForTool(tool: string, shellPref?: boolean, editPref?: boolean): DisplayMode | null {
  if ((tool === "bash" || tool === "shell") && shellPref !== undefined) {
    return shellPref ? "expanded" : "collapsed"
  }
  if ((tool === "edit" || tool === "write" || tool === "patch" || tool === "apply_patch") && editPref !== undefined) {
    return editPref ? "expanded" : "collapsed"
  }
  return null
}
