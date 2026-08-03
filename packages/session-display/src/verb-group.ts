import type { DisplayMode, PartStatus } from "./mode"

export type VerbGroupKind =
  | "file"
  | "skill"
  | "search"
  | "dir"
  | "webfetch"
  | "websearch"
  | "memory"
  | "integration"
  | "subagent"
  | "command"
  | "edit"
  | "mcp"
  | "other"

export interface VerbRunMemberInput {
  id: string
  tool: string
  status: PartStatus
  mode: DisplayMode
}

export interface VerbRun {
  kind: VerbGroupKind
  memberIds: string[]
  failed: boolean
  running: boolean
}

/** Eager-fold mapping by tool name (verified Grok `verb_group_kind()`). */
const EAGER_FOLD_BY_TOOL: Record<string, VerbGroupKind> = {
  read: "file",
  skill: "skill",
  grep: "search",
  glob: "search",
  list: "dir",
  webfetch: "webfetch",
  websearch: "websearch",
}

export function eagerFoldKind(tool: string): VerbGroupKind | null {
  return EAGER_FOLD_BY_TOOL[tool.toLowerCase()] ?? null
}

export function verbLabel(kind: VerbGroupKind, running: boolean): string {
  const [done, present] = VERB_BY_KIND[kind]
  return running ? present : done
}

export function nounLabel(kind: VerbGroupKind, count: number): string {
  const [one, many] = NOUN_BY_KIND[kind]
  return count === 1 ? one : many
}

const VERB_BY_KIND: Record<VerbGroupKind, readonly [string, string]> = {
  file: ["Read", "Reading"],
  skill: ["Used", "Using"],
  search: ["Searched", "Searching"],
  dir: ["Listed", "Listing"],
  webfetch: ["Fetched", "Fetching"],
  websearch: ["Searched", "Searching"],
  memory: ["Searched", "Searching"],
  integration: ["Searched", "Searching"],
  subagent: ["Ran", "Running"],
  command: ["Ran", "Running"],
  edit: ["Edited", "Editing"],
  mcp: ["Called", "Calling"],
  other: ["Ran", "Running"],
}

const NOUN_BY_KIND: Record<VerbGroupKind, readonly [string, string]> = {
  file: ["file", "files"],
  skill: ["skill", "skills"],
  search: ["pattern", "patterns"],
  dir: ["dir", "dirs"],
  webfetch: ["website", "websites"],
  websearch: ["website", "websites"],
  memory: ["memory", "memories"],
  integration: ["MCP tool", "MCP tools"],
  subagent: ["subagent", "subagents"],
  command: ["command", "commands"],
  edit: ["file", "files"],
  mcp: ["MCP tool", "MCP tools"],
  other: ["tool", "tools"],
}

/**
 * Classify runs of consecutive, collapsed, eager-foldable tool calls into
 * verb groups (verified Grok `run_step` + `scan_run_forward`): a Member is a
 * collapsed eager-fold tool; an opened/streaming entry or any other part
 * breaks the run. Returns one run per maximal consecutive same-kind streak
 * with at least one member.
 */
export function classifyVerbRuns(parts: readonly VerbRunMemberInput[]): VerbRun[] {
  const runs: VerbRun[] = []
  let current: VerbRun | null = null

  for (const part of parts) {
    const kind = part.mode === "collapsed" ? eagerFoldKind(part.tool) : null
    if (!kind || part.status === "error") {
      current = null
      continue
    }
    if (current && current.kind === kind) {
      current.memberIds.push(part.id)
      if (part.status === "running" || part.status === "pending") current.running = true
      continue
    }
    current = {
      kind,
      memberIds: [part.id],
      failed: false,
      running: part.status === "running" || part.status === "pending",
    }
    runs.push(current)
  }

  return runs
}

export function verbGroupHeaderLabel(run: VerbRun): string {
  return `${verbLabel(run.kind, run.running)} ${run.memberIds.length} ${nounLabel(run.kind, run.memberIds.length)}`
}
