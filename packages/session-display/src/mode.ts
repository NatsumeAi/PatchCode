export type DisplayMode = "collapsed" | "truncated" | "expanded"

export type FoldCycle = "two" | "three"

export type PartStatus = "pending" | "running" | "completed" | "error"

export type ToolFamily =
  | "read"
  | "search"
  | "write"
  | "edit"
  | "shell"
  | "web"
  | "task"
  | "todo"
  | "question"
  | "skill"
  | "mcp"
  | "generic"

export interface DisplayPolicy {
  streaming: DisplayMode
  /** "keep" = finish does not change mode (Grok finished_display_mode: None) */
  finished: DisplayMode | "keep"
  error: DisplayMode
  foldable: boolean
  truncatedLines?: number
  /** Fold cycle for click-toggle; default "two". Read uses "three" (Grok). */
  foldCycle?: FoldCycle
}

export interface ResolveModeInput {
  policy: DisplayPolicy
  status: PartStatus
  /** User clicked to pin; null/undefined = not pinned */
  userPin: DisplayMode | null
  /** Optional: shell uses exit code to determine logical failure */
  logicalError?: boolean
}

export function resolveMode(input: ResolveModeInput): DisplayMode {
  if (input.userPin != null) return input.userPin
  const failed = input.status === "error" || input.logicalError === true
  if (failed) return input.policy.error
  if (input.status === "pending" || input.status === "running") return input.policy.streaming
  // completed
  if (input.policy.finished === "keep") return input.policy.streaming
  return input.policy.finished
}

export interface HeaderModel {
  verb: string
  icon: string
  family: ToolFamily
  primary: string
  details: string
  muted: boolean
  status: PartStatus
  accent: ToolFamily | "error" | "muted"
}

export type BodyModel =
  | { kind: "none" }
  | { kind: "text"; text: string; maxLines?: number }
  | { kind: "diff"; diff: string; path: string; maxLines?: number }
  | { kind: "patch"; files: Array<{ path: string; diff: string; type: string }> }
  | { kind: "code"; content: string; path: string; maxLines?: number }
  | { kind: "todos"; items: Array<{ status: string; content: string }> }
  | { kind: "qa"; items: Array<{ question: string; answer: string }> }
  | { kind: "lines"; lines: string[]; maxLines?: number }

export interface ToolViewModel {
  mode: DisplayMode
  header: HeaderModel
  body: BodyModel
  userPinned: boolean
  clickable: boolean
  /** Adapter hint: collapsed forbids thick panel */
  chrome: "inline" | "panel"
}

export function chromeFor(mode: DisplayMode): "inline" | "panel" {
  return mode === "collapsed" ? "inline" : "panel"
}
