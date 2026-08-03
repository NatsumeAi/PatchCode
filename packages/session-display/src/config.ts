import type { DisplayMode, DisplayPolicy } from "./mode"

export interface DisplayConfig {
  collapsedEditBlocks: boolean
  mutedCollapsed: boolean
  dimDetails: boolean
  groupToolVerbs: boolean
  diffMaxLines: number
  shellErrorTruncatedLines: number
  reasoningTruncatedLines: number
  genericToolOutput: boolean
  tools: {
    [family: string]: Partial<DisplayPolicy> & { truncatedLines?: number }
  }
  reasoning: {
    streaming: DisplayMode
    finished: DisplayMode
    truncatedLines: number
  }
}

/** §4 gold defaults — the product law for new installs. */
export const DEFAULT_CONFIG: DisplayConfig = {
  collapsedEditBlocks: false,
  mutedCollapsed: true,
  dimDetails: true,
  groupToolVerbs: false,
  diffMaxLines: 500,
  shellErrorTruncatedLines: 8,
  reasoningTruncatedLines: 3,
  genericToolOutput: false,
  tools: {},
  reasoning: {
    streaming: "truncated",
    finished: "collapsed",
    truncatedLines: 3,
  },
}

/** Loose merge: user config over base; unknown keys ignored, never throws. */
export function mergeConfig(base: DisplayConfig, user: unknown): DisplayConfig {
  if (user == null || typeof user !== "object") return base
  const u = user as Record<string, unknown>
  const result: DisplayConfig = { ...base, tools: { ...base.tools }, reasoning: { ...base.reasoning } }

  if (typeof u.collapsedEditBlocks === "boolean") result.collapsedEditBlocks = u.collapsedEditBlocks
  if (typeof u.mutedCollapsed === "boolean") result.mutedCollapsed = u.mutedCollapsed
  if (typeof u.dimDetails === "boolean") result.dimDetails = u.dimDetails
  if (typeof u.groupToolVerbs === "boolean") result.groupToolVerbs = u.groupToolVerbs
  if (typeof u.diffMaxLines === "number") result.diffMaxLines = u.diffMaxLines
  if (typeof u.shellErrorTruncatedLines === "number") result.shellErrorTruncatedLines = u.shellErrorTruncatedLines
  if (typeof u.reasoningTruncatedLines === "number") result.reasoningTruncatedLines = u.reasoningTruncatedLines
  if (typeof u.genericToolOutput === "boolean") result.genericToolOutput = u.genericToolOutput

  if (u.tools != null && typeof u.tools === "object") {
    const tools = u.tools as Record<string, unknown>
    for (const key of Object.keys(tools)) {
      const val = tools[key]
      if (val != null && typeof val === "object") {
        result.tools[key] = { ...(base.tools[key] ?? {}), ...(val as Record<string, unknown>) } as DisplayConfig["tools"][string]
      }
    }
  }

  if (u.reasoning != null && typeof u.reasoning === "object") {
    const r = u.reasoning as Record<string, unknown>
    if (r.streaming === "collapsed" || r.streaming === "truncated" || r.streaming === "expanded")
      result.reasoning.streaming = r.streaming
    if (r.finished === "collapsed" || r.finished === "truncated" || r.finished === "expanded")
      result.reasoning.finished = r.finished
    if (typeof r.truncatedLines === "number") result.reasoning.truncatedLines = r.truncatedLines
  }

  return result
}
