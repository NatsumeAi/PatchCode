# Grok Verb-Group Aggregation — Design Spec

> **Status: IMPLEMENTED (2026-08-03, approved by user).** Design preserved as
> the reference for the implementation. Implementation:
> - `packages/session-display/src/verb-group.ts` — `classifyVerbRuns`/`verbGroupHeaderLabel`/verb+noun
> - `packages/session-display/test/verb-group.test.ts` — 15 tests
> - `packages/tui/src/display/VerbGroupHeader.tsx` — header row (rail+bullet+disclosure)
> - `packages/tui/src/routes/session/index.tsx` — AssistantMessage grouping
> - `groupToolVerbs` default flipped to `true` (Grok default)
>
> Source of truth: verified Grok `xai-grok-pager` code.
> Reference paths (verified 2026-08-03):
> - `crates/codegen/xai-grok-pager/src/scrollback/blocks/tool/mod.rs:83-151` — `VerbGroupKind` + verb/noun
> - `crates/codegen/xai-grok-pager/src/scrollback/state/verb_group.rs:29-260` — `RunStep`/`run_step`/`scan_run_forward`/`verb_group_header_label`
> - `crates/codegen/xai-grok-pager/src/scrollback/state/layout.rs:1385-1429` — `recompute_gap_after`
> - `crates/codegen/xai-grok-config-types/src/lib.rs:669` — `group_tool_verbs` remote flag (default true)

## 1. Concept

Grok folds runs of consecutive, collapsed, non-destructive tool calls of the
same kind into a single transcript row:

```text
Read 3 files          ← verb-group header (click expands)
Searched 2 patterns   ← or: Reading 1 file (present tense while running)
Ran 2 subagents
```

This is the single biggest timeline-density feature we lack. It is **orthogonal
to** per-entry folding (Phase A–E): a verb-group header is a real fold that
hides member rows.

## 2. Classification (verified `blocks/tool/mod.rs:83-151`)

`VerbGroupKind` with **eager-fold** members vs **label-only** buckets:

| Kind | verb (done/running) | noun (1/n) | eager-fold? |
|---|---|---|---|
| File | Read / Reading | file / files | ✅ |
| Skill | Used / Using | skill / skills | ✅ |
| Search | Searched / Searching | pattern / patterns | ✅ |
| Dir | Listed / Listing | dir / dirs | ✅ |
| WebFetch | Fetched / Fetching | website / websites | ✅ |
| WebSearch | Searched / Searching | website / websites | ✅ |
| MemorySearch | Searched / Searching | memory / memories | ✅ |
| IntegrationSearch | Searched / Searching | MCP tool / MCP tools | ✅ |
| Subagent | Ran / Running | subagent / subagents | ✅ |
| Command (shell) | Ran / Running | command / commands | ❌ label-only |
| EditFile | Edited / Editing | file / files | ❌ label-only |
| McpCall | Called / Calling | MCP tool / MCP tools | ❌ label-only |
| OtherTool | Ran / Running | tool / tools | ❌ label-only |

Key asymmetry (verified `verb_group_kind()` vs `label_kind()`):
- **Eager-fold set** = File, Skill, Search, Dir, WebFetch, WebSearch,
  MemorySearch, IntegrationSearch, Subagent. These fold into a header.
- **Label-only** = Command, EditFile, McpCall, OtherTool. They never fold
  eagerly (side-effecting), but a *truncation* header ("N more") may bucket
  them: `Ran 6 commands, Read 2 files`.

## 3. Run semantics (verified `verb_group.rs`)

- `RunStep` per entry: `Member(kind)` (collapsed groupable), `ThoughtMember`
  (finished collapsed thinking claims in, height 0, never counted),
  `Transparent` (opened/hidden/streaming — keeps own rows, run stays whole),
  `Break` (anything else ends the run).
- Fold trigger: `folds()` = `members >= 1` (at least one Member; a pure
  thinking run never folds — verified).
- A manually-expanded member becomes `Transparent`: the group stays intact
  instead of splitting.
- Header label aggregates via `BucketAccumulator`: `"Searched 3 patterns"`,
  present tense while running, `· N failed` red suffix for failed members.
- WebSearch counts **distinct URLs**; Subagent counts **distinct
  child_session_id**.
- Member rows inside a run keep **0 gap** (Phase E1 precondition — already
  implemented).

## 4. Proposed kernel interface (NOT implemented)

```ts
// packages/session-display/src/verb-group.ts (future)
export type VerbGroupKind =
  | "file" | "skill" | "search" | "dir" | "webfetch" | "websearch"
  | "memory" | "integration" | "subagent"
  | "command" | "edit" | "mcp" | "other"

export interface VerbRunMember {
  partId: string
  kind: VerbGroupKind
  failed?: boolean
  running?: boolean
}

export interface VerbRun {
  kind: VerbGroupKind
  /** Inclusive part-id range over a flattened, ordered part list. */
  memberIds: string[]
  /** Distinct-count noun input (URLs / child session ids) when applicable. */
  countBy?: "urls" | "children" | "entries"
}

/** Single source of truth for run classification — shared by TUI + Web. */
export function classifyVerbRuns(
  parts: readonly {
    id: string
    tool: string
    status: PartStatus
    mode: DisplayMode
  }[],
): VerbRun[]
```

### Mapping from our ToolViewModel

| Our family | VerbGroupKind |
|---|---|
| read | file |
| search (grep/glob) | search |
| list | dir |
| web (webfetch) | webfetch |
| web (websearch) | websearch |
| task/execute | subagent (execute→label-only command) |
| edit/write/patch | edit (label-only edit) |
| skill | skill |
| todo/question/mcp/generic | other / mcp (label-only) |

## 5. Interaction model

- A verb-group header renders as a **real fold**: member rows hidden, header
  shows `◆ Verb N noun` with the group's run-state accent (running→wave,
  failed→red, else dimmed `❙` per Phase B).
- `Enter` / `e` on the header toggles the group (Grok `toggle_group_expansion`).
- `E` expand-all expands groups too (member ids are in the pin store).
- Expanding a member inside a folded group keeps the group whole (member
  becomes `Transparent`).
- Keyboard selection (Phase C) operates on the **header** as a unit when
  folded, or on individual members when expanded.

## 6. Config

- `DisplayConfig.groupToolVerbs` already exists (default `false`). Phase D
  flips the default to `true` (Grok default) **only after review** — the
  current default keeps v1 behavior identical.
- `collapsedEditBlocks` remains independent (edit/write/patch are label-only
  here; they never eagerly fold).

## 7. Web (session-ui) impact

- Web `HIDDEN_TOOLS`/TodoDock unchanged.
- Web timeline does **not** implement verb-group in this design (Web already
  has `ContextToolGroup` for read/search grouping). Verify the two don't
  double-group before touching Web.

## 8. Decision points for review

1. **Real fold vs visual overlay** — Grok uses a real fold (rows hidden). We
   recommend the same; it matches Phase E1 gap-0 and `E` expand-all.
2. **Default `groupToolVerbs`** — flip to `true` (Grok default) or keep
   `false` for a smoother rollout? Recommend: flip `true` in the same review
   that approves Phase D, with snapshot tests updated.
3. **Where the classifier lives** — kernel `session-display` pure function
   (recommended) so TUI and future Web share one implementation.
4. **Subagent counting** — our `task` parts carry `metadata.sessionId` for
   distinct-child counting; confirm it is always present for background tasks.
5. **Thinking absorption** — `ThoughtMember` (thinking folds to height 0
   inside a run) requires our reasoning parts to be in the same flattened
   ordering as tool parts; confirm the TUI part stream guarantees this.

## 9. Out of scope (v1 of Phase D)

- Truncation headers for label-only buckets (`Ran 6 commands`) — deferred.
- `collapsedEditBlocks` user config wiring — separate follow-up.

**Awaiting review. Do not implement until approved.**
