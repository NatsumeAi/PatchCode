import type { DisplayMode, PartStatus } from "./mode"
import { normalizeToolName } from "./normalize"

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
  /** Number of failed members (Grok `failed_count`, verified verb_group.rs:319). */
  failedCount: number
  running: boolean
}

/** Eager-fold mapping by normalized tool name (verified Grok `verb_group_kind()`). */
const EAGER_FOLD_BY_TOOL: Record<string, VerbGroupKind> = {
  read: "file",
  skill: "skill",
  grep: "search",
  glob: "search",
  list: "dir",
  webfetch: "webfetch",
  websearch: "websearch",
  // Grok Subagent is eager-fold; our task tool is the subagent launcher.
  task: "subagent",
}

export function eagerFoldKind(tool: string): VerbGroupKind | null {
  const normalized = normalizeToolName(tool)
  return EAGER_FOLD_BY_TOOL[normalized] ?? null
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
 * collapsed eager-fold tool regardless of status — failed members stay in the
 * run and are counted (`failed_count`). A non-eager, opened, or non-tool
 * entry breaks the run. Returns one run per maximal consecutive same-kind
 * streak with at least one member.
 *
 * Callers should pass the flattened tool sequence (non-tools already removed)
 * or pass every part with non-tools marked mode≠collapsed / tool="" so they break.
 */
export function classifyVerbRuns(parts: readonly VerbRunMemberInput[]): VerbRun[] {
  const runs: VerbRun[] = []
  let current: VerbRun | null = null

  const failed = (status: PartStatus) => status === "error"
  const running = (status: PartStatus) => status === "running" || status === "pending"

  for (const part of parts) {
    // Expanded/truncated tools are Transparent in Grok (keep own row, do not
    // break the run). Only non-eager tools and non-members break the streak.
    if (part.mode !== "collapsed") {
      // Transparent: leave current run open so later collapsed siblings still fold.
      continue
    }
    const kind = eagerFoldKind(part.tool)
    if (!kind) {
      current = null
      continue
    }
    if (current && current.kind === kind) {
      current.memberIds.push(part.id)
      if (running(part.status)) current.running = true
      if (failed(part.status)) current.failedCount += 1
      continue
    }
    current = {
      kind,
      memberIds: [part.id],
      failedCount: failed(part.status) ? 1 : 0,
      running: running(part.status),
    }
    runs.push(current)
  }

  return runs
}

/**
 * Build the display item list for an assistant message: verb-group headers for
 * multi-member collapsed runs, plus individual parts (members hidden when the
 * run is collapsed). Pure — easy to unit-test without Solid.
 */
export function buildGroupedItems<P extends { id: string; type: string }>(
  parts: readonly P[],
  runs: readonly VerbRun[],
  expandedRunKeys: ReadonlySet<string>,
  runKey: (run: VerbRun) => string = (run) => `${run.kind}:${run.memberIds[0]}`,
): Array<{ kind: "header"; run: VerbRun } | { kind: "part"; part: P; last: boolean }> {
  const multi = new Map<string, VerbRun>()
  for (const run of runs) {
    if (run.memberIds.length < 2) continue
    for (const id of run.memberIds) multi.set(id, run)
  }
  const items: Array<{ kind: "header"; run: VerbRun } | { kind: "part"; part: P; last: boolean }> = []
  const seen = new Set<string>()
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const last = i === parts.length - 1
    const run = part.type === "tool" ? multi.get(part.id) : undefined
    if (run) {
      const expanded = expandedRunKeys.has(runKey(run))
      if (!seen.has(part.id)) {
        for (const id of run.memberIds) seen.add(id)
        items.push({ kind: "header", run })
        if (!expanded) continue
      } else if (!expanded) {
        continue
      }
    }
    items.push({ kind: "part", part, last })
  }
  return items
}

export function verbGroupHeaderLabel(run: VerbRun): string {
  const base = `${verbLabel(run.kind, run.running)} ${run.memberIds.length} ${nounLabel(run.kind, run.memberIds.length)}`
  return run.failedCount > 0 ? `${base} · ${run.failedCount} failed` : base
}
