import type { ToolPart } from "@opencode-ai/sdk/v2"
import { normalizeToolName } from "./normalize"
import { getDescriptor } from "./registry"
import { genericDescriptor } from "./tools/generic"
import { chromeFor, resolveMode, type DisplayMode, type ToolViewModel } from "./mode"
import type { DisplayContext } from "./registry"

export function buildToolViewModel(
  part: ToolPart,
  ctx: DisplayContext,
  pin: DisplayMode | null,
): ToolViewModel {
  const normalized = normalizeToolName(part.tool)
  const descriptor = getDescriptor(normalized) ?? genericDescriptor
  const policy = descriptor.policy(ctx.config)
  const logicalError = descriptor.logicalError?.(part) ?? false
  const status = part.state.status

  let mode = resolveMode({ policy, status, userPin: pin, logicalError })
  let body = descriptor.body(part, mode, ctx)

  // §4 content-dependence: edit/write/patch without diff/content/files must
  // land collapsed even when policy.finished is expanded. A pinned mode is
  // user intent (§3.8) and must never be collapsed here.
  if (pin == null && mode === "expanded" && body.kind === "none") {
    mode = "collapsed"
    body = descriptor.body(part, mode, ctx)
  }

  const header = descriptor.header(part, ctx)
  // P1-1: logical failure (shell exit≠0 / timeout) renders as an error row.
  if (logicalError) header.accent = "error"

  // §5: muted = config.mutedCollapsed && completed && collapsed && !error
  const muted = ctx.config.mutedCollapsed && status === "completed" && mode === "collapsed" && !logicalError

  return {
    mode,
    header: { ...header, muted, dimDetails: ctx.config.dimDetails },
    body,
    userPinned: pin != null,
    clickable: policy.foldable,
    chrome: chromeFor(mode),
  }
}
