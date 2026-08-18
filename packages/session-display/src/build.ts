import type { ToolPart } from "@opencode-ai/sdk/api"
import { normalizeToolName } from "./normalize"
import { getDescriptor } from "./registry"
import { genericDescriptor } from "./tools/generic"
import { chromeFor, resolveMode, type DisplayMode, type ToolViewModel } from "./mode"
import type { DisplayContext } from "./registry"
import { toText } from "./header-utils"

/** Force every header/body field to a string so opentui text nodes never see dirty values. */
function sanitizeHeader(header: ToolViewModel["header"]): ToolViewModel["header"] {
  return {
    ...header,
    verb: toText(header.verb),
    icon: toText(header.icon),
    primary: toText(header.primary),
    details: toText(header.details),
  }
}

function sanitizeBody(body: ToolViewModel["body"]): ToolViewModel["body"] {
  switch (body.kind) {
    case "none":
      return body
    case "text":
      return { ...body, text: toText(body.text) }
    case "diff":
      return { ...body, diff: toText(body.diff), path: toText(body.path) }
    case "code":
      return { ...body, content: toText(body.content), path: toText(body.path) }
    case "patch":
      return {
        ...body,
        files: body.files.map((file) => ({
          path: toText(file.path),
          diff: toText(file.diff),
          type: toText(file.type),
        })),
      }
    case "todos":
      return {
        ...body,
        items: body.items.map((item) => ({ status: toText(item.status), content: toText(item.content) })),
      }
    case "qa":
      return {
        ...body,
        items: body.items.map((item) => ({ question: toText(item.question), answer: toText(item.answer) })),
      }
    case "lines":
      return { ...body, lines: body.lines.map((line) => toText(line)) }
  }
}

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
    header: sanitizeHeader({ ...header, muted, dimDetails: ctx.config.dimDetails }),
    body: sanitizeBody(body),
    userPinned: pin != null,
    clickable: policy.foldable,
    chrome: chromeFor(mode),
  }
}
