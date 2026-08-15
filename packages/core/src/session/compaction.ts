export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, SystemPart, type LLMRequest, type Model } from "@opencode-ai/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 20_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_BUDGET_L = 20_000
const SUMMARY_BUDGET_K = 272_000

/**
 * Summary output budget via the MM saturating formula
 * `L * x / (x + K)` with L=20000, K=272000 (plan Task 6).
 * Anchors: 128K→6400, 272K→10000, 1M→15700, 2M→17600.
 */
export const summaryBudget = (contextWindow: number, l = SUMMARY_BUDGET_L, k = SUMMARY_BUDGET_K) => {
  const window = Math.max(0, contextWindow)
  return Math.max(1, Math.floor((l * window) / (window + k)))
}

/**
 * Residual token budget for selected (verbatim) items under the total
 * post-compaction constraint (plan Task 6 / P1-4 full form):
 *
 *   summary + selected + recent + system/tools ≤ contextWindow − buffer
 *
 * Returns the max tokens available for `selected`. Recent is never shrunk here
 * (priority: keep recent, shrink selected when over).
 */
export const selectedBudgetCap = (input: {
  readonly contextWindow: number
  readonly buffer: number
  readonly summaryTokens: number
  readonly recentTokens: number
  readonly systemToolsTokens: number
}): number => {
  const capacity = Math.max(0, input.contextWindow - Math.max(0, input.buffer))
  const fixed =
    Math.max(0, input.summaryTokens) + Math.max(0, input.recentTokens) + Math.max(0, input.systemToolsTokens)
  return Math.max(0, capacity - fixed)
}

/** Pack items largest-first until `limit` tokens; used by D9 greedy and total-budget shrink. */
export const packLargestFirst = (
  items: readonly { readonly label: string; readonly tokens: number }[],
  limit: number,
): readonly string[] => {
  if (limit <= 0) return []
  const keep: string[] = []
  let sum = 0
  for (const item of [...items].sort((a, b) => b.tokens - a.tokens)) {
    if (sum + item.tokens <= limit) {
      keep.push(item.label)
      sum += item.tokens
    }
  }
  return keep
}
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer?: number
  readonly selectEnabled: boolean
  readonly selectBudget: number
  readonly selectRetry: number
  readonly keepRecentRatio: number
  readonly keepRecentMax: number
  readonly summaryL: number
  readonly summaryK: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
  /**
   * Best-effort pre-compress insight extraction (memory wiring, optional).
   * Returns markdown appended to the summarize prompt as a
   * "## Memory insights to preserve" section, or "" for none. Absent wiring
   * and failures both degrade to "" — compaction never depends on memory.
   */
  readonly onPreCompress?: (
    entries: readonly Entry[],
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<string>
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
  /** Defaults to "auto". Manual compact must pass "manual". */
  readonly reason?: "auto" | "manual"
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

/**
 * Render numbered selection items for the selection prompt:
 * `[3] (2.1%) x3 [User]: first serialized line`
 *
 * - percentage = item tokens / contextWindow
 * - survival tag (`xN`) is read from the `survival` map (keyed by item key)
 *   and omitted when absent/zero
 */
export const formatNumberedItems = (
  items: readonly TurnItem[],
  contextWindow: number,
  survival?: Readonly<Record<string, number>>,
): string =>
  items
    .map((item) => {
      const percent = contextWindow > 0 ? ((item.tokens / contextWindow) * 100).toFixed(1) : "0.0"
      const survivalCount = survival?.[item.key] ?? 0
      const survivalTag = survivalCount > 0 ? ` ×${survivalCount}` : ""
      const continuationTag = item.continuation === true ? "（续）" : ""
      const preview = item.entries[0] ? serialize(item.entries[0].message).split("\n")[0]!.slice(0, 80) : ""
      return `[${item.label}${continuationTag}] (${percent}%)${survivalTag} ${preview}`
    })
    .join("\n")

/**
 * System prompt for the summarization request. Instructs structured output
 * (a summary plus a <selection> tag) rather than conversation.
 */
/**
 * System prompt for correction rounds: the summary is already cached (D15);
 * the model only re-issues a corrected <selection> list.
 */
export const SELECTION_ONLY_SYSTEM_PROMPT = `You previously selected items from a numbered conversation. Your <selection> tag was rejected for the reasons in <correction>. Output ONLY a new <selection> tag listing corrected item numbers (for example <selection>[3,7]</selection>, or <selection>[]</selection> if nothing is worth keeping). Do not output a summary or any other text.`

const correctionPromptFor = (errors: readonly string[], numbered: string) =>
  [
    "The conversation is unchanged. Output only a new <selection> tag with corrected item numbers, within the stated budget.",
    numbered ? `<numbered-context>\n${numbered}\n</numbered-context>` : "",
    `<correction>\n${errors.join("\n")}\n</correction>`,
  ].filter(Boolean).join("\n\n")

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarizer for an agentic coding session.
Do not converse, ask questions, or offer help. Read the numbered conversation items and the full history inside <conversation>, then output exactly:

1. An anchored summary following the template below (keep every section, even when empty).
2. A <selection> tag listing the numbers of the items you selected to keep verbatim, for example <selection>[3,7,12b]</selection>.

Select items that are still critical to the task (unfinished work, active decisions, relevant details). Prefer quality over quantity; the selection must stay within the stated budget.`
export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      selectEnabled: current.select?.enabled ?? result.selectEnabled,
      selectBudget: current.select?.budget ?? result.selectBudget,
      selectRetry: current.select?.retry ?? result.selectRetry,
      keepRecentRatio: current.keep?.recent ?? result.keepRecentRatio,
      keepRecentMax: result.keepRecentMax,
      summaryL: current.summary?.l ?? result.summaryL,
      summaryK: current.summary?.k ?? result.summaryK,
    }),
    {
      auto: true,
      buffer: undefined,
      selectEnabled: true,
      selectBudget: SELECTION_RATIO,
      selectRetry: 1,
      keepRecentRatio: KEEP_RECENT_RATIO,
      keepRecentMax: KEEP_RECENT_MAX,
      summaryL: SUMMARY_BUDGET_L,
      summaryK: SUMMARY_BUDGET_K,
    },
  )
}

export type Turn = {
  readonly key: string
  readonly tokens: number
  readonly entries: readonly Entry[]
}

export type TurnItem = {
  readonly key: string
  readonly kind: "turn" | "subturn"
  readonly label: string
  readonly tokens: number
  readonly survival: number
  /** Subturn cut from the middle of a turn (no leading user/synthetic message). */
  readonly continuation?: boolean
  readonly entries: readonly Entry[]
}

const isTurnStart = (message: SessionMessage.Message) => message.type === "user" || message.type === "synthetic"

/**
 * Group entries into turns. A turn starts at a user/synthetic message; leading
 * non-user messages (system baseline, agent/model switches) form their own
 * numbered turn. Groups are message-granular: in the v2 message model a tool
 * call and its result live inside one assistant message, so no cut can ever
 * separate them (equivalent to Pi's isCutPointMessage constraint).
 */
const groupTurns = (entries: readonly Entry[]): Turn[] => {
  const turns: Turn[] = []
  let current: Entry[] = []
  const flush = () => {
    if (current.length === 0) return
    turns.push({
      key: current[0]!.message.id,
      tokens: current.reduce((sum, entry) => sum + Token.estimate(serialize(entry.message)), 0),
      entries: current,
    })
    current = []
  }
  for (const entry of entries) {
    if (isTurnStart(entry.message)) {
      flush()
      current = [entry]
    } else {
      current.push(entry)
    }
  }
  flush()
  return turns
}

/**
 * Turn-granular selection (compaction v3).
 *
 * - `recentBudget`: keep-recent token allowance; the cut always lands on a turn
 *   start — a turn that does not fit goes entirely to `head` (never half-cut).
 * - `selectionLimit`: per-turn subturn split threshold (an oversized turn is
 *   split into subturns each under 2/3 of the limit, at message boundaries).
 *
 * Replaces the old string-level `select` slice behavior entirely.
 */
export const selectTurns = (
  entries: readonly Entry[],
  recentBudget: number,
  selectionLimit: number,
): { readonly head: Turn[]; readonly recent: Turn[]; readonly items: TurnItem[] } => {
  const turns = groupTurns(entries.filter((entry) => entry.message.type !== "compaction"))
  const recent: Turn[] = []
  let recentTokens = 0
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!
    if (recentTokens + turn.tokens <= recentBudget) {
      recentTokens += turn.tokens
      recent.unshift(turn)
    } else {
      break
    }
  }
  const head = turns.slice(0, turns.length - recent.length)
  const items: TurnItem[] = []
  const subturnLimit = (selectionLimit * 2) / 3
  head.forEach((turn, index) => {
    const label = String(index + 1)
    if (turn.tokens <= subturnLimit) {
      items.push({ key: turn.key, kind: "turn", label, tokens: turn.tokens, survival: 0, entries: turn.entries })
      return
    }
    let slice: Entry[] = []
    let sliceTokens = 0
    let sub = 1
    const flushSlice = () => {
      if (slice.length === 0) return
      const first = slice[0]!.message
      items.push({
        key: slice[0]!.message.id,
        kind: "subturn",
        label: `${label}${String.fromCharCode(96 + sub)}`,
        tokens: sliceTokens,
        survival: 0,
        continuation: sub > 1 || !isTurnStart(first),
        entries: slice,
      })
      sub += 1
      slice = []
      sliceTokens = 0
    }
    for (const entry of turn.entries) {
      const tokens = Token.estimate(serialize(entry.message))
      if (slice.length > 0 && sliceTokens + tokens > subturnLimit) flushSlice()
      slice.push(entry)
      sliceTokens += tokens
    }
    flushSlice()
  })
  return { head, recent, items }
}

export type FileOps = {
  readonly read: readonly string[]
  readonly modified: readonly string[]
}

/**
 * Extract file operations from assistant tool calls (read/write/edit) and
 * merge them with the previous compaction's file list (deduplicated).
 *
 * Pi utils.ts semantics: `modified = edit ∪ write`; a file that was written or
 * edited is never listed under `read` (`read = readOnly − modified`).
 */
export const extractFileOps = (
  messages: readonly SessionMessage.Message[],
  previous?: FileOps,
): FileOps => {
  const read = new Set<string>(previous?.read ?? [])
  const modified = new Set<string>(previous?.modified ?? [])
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      const input = part.state.input as Record<string, unknown>
      const pathValue = typeof input?.path === "string" ? input.path : undefined
      if (pathValue === undefined) continue
      if (part.name === "read") read.add(pathValue)
      if (part.name === "write" || part.name === "edit") modified.add(pathValue)
    }
  }
  const filteredRead = [...read].filter((path) => !modified.has(path)).sort()
  return { read: filteredRead, modified: [...modified].sort() }
}

const renderFilesXml = (files: FileOps | undefined): string => {
  if (!files || (files.read.length === 0 && files.modified.length === 0)) return ""
  const lines: string[] = []
  if (files.read.length > 0) lines.push(`<read-files>${files.read.join(", ")}</read-files>`)
  if (files.modified.length > 0) lines.push(`<modified-files>${files.modified.join(", ")}</modified-files>`)
  return `<files>\n${lines.join("\n")}\n</files>`
}

export const parseSelection = (
  output: string,
): { readonly ok: true; readonly selected: readonly string[] } | { readonly ok: false; readonly errors: readonly string[] } => {
  const start = output.indexOf("<selection>")
  const end = output.indexOf("</selection>")
  if (start < 0 || end < 0 || end <= start) return { ok: false, errors: ["missing <selection> tag"] }
  const inner = output.slice(start + "<selection>".length, end).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(inner)
  } catch {
    // The model may emit a bare list like [3,7,12b] without JSON quotes; fall
    // back to splitting on commas.
    const cleaned = inner.replace(/^\[/, "").replace(/\]$/, "")
    const parts = cleaned
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    // An empty or whitespace-only tag is a zero selection, not a failure (N1).
    if (parts.length === 0) return { ok: true, selected: [] }
    return { ok: true, selected: parts }
  }
  if (!Array.isArray(parsed)) return { ok: false, errors: ["<selection> is not an array"] }
  const selected = parsed.map((item) => String(item))
  // An empty selection is valid (design §5.3: nothing worth keeping verbatim);
  // the pure-summary path is a legitimate outcome, not a parse failure.
  return { ok: true, selected }
}

export const validateSelection = (input: {
  readonly selected: readonly string[]
  readonly items: readonly TurnItem[]
  readonly limit: number
  readonly maxItems: number
}):
  | { readonly ok: true; readonly selected: readonly string[]; readonly tokens: number }
  | {
      readonly ok: false
      readonly errors: readonly string[]
      readonly overBudget?: boolean
      readonly selectedTokens?: number
      readonly selected?: readonly string[]
    } => {
  const errors: string[] = []
  const unknown = input.selected.filter((label) => !input.items.some((item) => item.label === label))
  if (unknown.length > 0) errors.push(`unknown item numbers: ${unknown.join(", ")}`)
  if (input.selected.length > input.maxItems) errors.push(`too many items: ${input.selected.length} > ${input.maxItems}`)
  const tokens = input.items
    .filter((item) => input.selected.includes(item.label))
    .reduce((sum, item) => sum + item.tokens, 0)
  if (tokens > input.limit * 1.5) {
    errors.push(`selection exceeds 1.5x budget: ${tokens} > ${input.limit * 1.5} (limit ${input.limit})`)
    return { ok: false, errors, overBudget: true, selectedTokens: tokens, selected: input.selected }
  }
  // Selections up to 1.5x the limit are accepted (correction loop skips them);
  // only genuine violations (unknown numbers, item cap, >1.5x budget) fail.
  return errors.length > 0
    ? { ok: false, errors, selectedTokens: tokens }
    : { ok: true, selected: input.selected, tokens }
}

export const buildPrompt = (input: {
  readonly previousSummary?: string
  readonly numberedItems?: string
  readonly selectionGuidance?: string
  readonly context: readonly string[]
}) => {
  // Stable prefix first (instruction + template), then the incremental
  // previous-summary, the full conversation, and finally the numbered
  // selection list (most volatile; kept last per the cache-layout convention).
  const parts: string[] = []
  if (input.previousSummary) {
    parts.push(
      [
        "Update the anchored summary below using the conversation history.",
        "Follow these rules when updating:",
        "- PRESERVE every still-true detail from the previous summary; keep exact file paths, function names, and error strings.",
        "- ADD new progress, decisions, and file operations from the conversation below.",
        "- UPDATE the Work State: move finished items from Active to Completed, revise Blocked, and refresh Next Move based on what was accomplished.",
        `<previous-summary>\n${input.previousSummary}\n</previous-summary>`,
      ].join("\n"),
    )
  } else {
    parts.push("Create a new anchored summary from the conversation history.")
  }
  parts.push(SUMMARY_TEMPLATE)
  parts.push(`<conversation>\n${input.context.filter(Boolean).join("\n\n")}\n</conversation>`)
  if (input.numberedItems) {
    if (input.selectionGuidance) parts.push(input.selectionGuidance)
    parts.push(`<numbered-context>\n${input.numberedItems}\n</numbered-context>`)
  }
  return parts.join("\n\n")
}

/** Append insights as a "## Memory insights to preserve" section (no-op when empty). */
const withInsights = (prompt: string, insights: string) =>
  insights.trim() === "" ? prompt : `${prompt}\n\n## Memory insights to preserve\n${insights}`

const renderTurns = (turns: readonly Turn[]) =>
  turns
    .flatMap((turn) => turn.entries.map((entry) => serialize(entry.message)))
    .filter(Boolean)
    .join("\n\n")

const stripSelection = (output: string) => {
  const start = output.indexOf("<selection>")
  const end = output.indexOf("</selection>")
  if (start < 0 || end < 0) return output.trim()
  return (output.slice(0, start) + output.slice(end + "</selection>".length)).trim()
}

const SELECTION_RATIO = 0.1
const KEEP_RECENT_RATIO = 0.1
const KEEP_RECENT_MAX = 20_000
const MAX_SUMMARIZE_CALLS = 4

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const reason = input.reason ?? "auto"
    // V1 processor: compaction.auto === false means 413/overflow stops the turn
    // with ContextOverflowError instead of auto-compacting.
    if (reason === "auto" && !config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const recentBudget = Math.min(Math.floor(context * config.keepRecentRatio), config.keepRecentMax)
    const configuredSelection = Math.floor(context * config.selectBudget)
    const maxItems = context >= 1_000_000 ? 20 : 10
    // Trigger / total-budget buffer: min(10% window, 20k) unless configured (D13: no maxOutput).
    const bufferTokens = config.buffer ?? Math.min(Math.floor(context * 0.1), DEFAULT_BUFFER)
    // selectTurns uses the configured ratio for subturn split; the effective
    // selection limit is tightened below by the total post-compaction cap.
    const selected = selectTurns(input.entries, recentBudget, configuredSelection)
    const recentTokens = selected.recent.reduce((sum, turn) => sum + turn.tokens, 0)
    const systemToolsTokens = estimate({
      system: input.request.system,
      tools: input.request.tools,
    })
    const summaryOutput = summaryBudget(context, config.summaryL, config.summaryK)
    // Full total-budget form (P1-4): shrink the selectable budget so that
    // summary + selected + recent + system/tools ≤ context − buffer.
    // Recent is protected (never reduced here); only selected yields.
    const totalSelectedCap = selectedBudgetCap({
      contextWindow: context,
      buffer: bufferTokens,
      summaryTokens: summaryOutput,
      recentTokens,
      systemToolsTokens,
    })
    const selectionLimit = Math.min(configuredSelection, totalSelectedCap)
    const previousCompaction = input.entries.findLast((entry) => entry.message.type === "compaction")?.message
    const previousSummary = previousCompaction?.type === "compaction" ? previousCompaction.summary : undefined
    const previousSurvival =
      previousCompaction?.type === "compaction" ? (previousCompaction.survival ?? {}) : {}
    const previousFiles = previousCompaction?.type === "compaction" ? previousCompaction.files : undefined
    const fileOps = extractFileOps(input.entries.map((entry) => entry.message), previousFiles)
    const head = renderTurns(selected.head)
    if (head.length === 0 && previousCompaction?.type !== "compaction") return false
    const numbered = formatNumberedItems(selected.items, context, previousSurvival)
    const selectionGuidance =
      selected.items.length === 0
        ? undefined
        : `Selection budget: at most ${selectionLimit} tokens (${((selectionLimit / context) * 100).toFixed(0)}% of the ${context} token window), max ${maxItems} items.
Choose items that are hard to compress (large code blocks, exact formats) or whose loss would drop critical information (user preferences, constraints, decision rationales, exact error strings, file paths, long task descriptions).
Items marked ×N have survived N previous compactions — keep them if they are still important, or let them go when the summary already covers them.
If nothing is worth keeping verbatim, output <selection>[]</selection>.`
    const fullHistory = [head].filter(Boolean)
    // Best-effort pre-compress insights (memory wiring): absent wiring and
    // failures both degrade to "" so compaction never depends on memory.
    const insights = yield* (dependencies.onPreCompress?.(input.entries, input.sessionID) ?? Effect.succeed("")).pipe(
      Effect.catch(() => Effect.succeed("")),
    )
    const basePrompt = buildPrompt({ previousSummary, numberedItems: numbered, selectionGuidance, context: fullHistory })
    const withMemory = withInsights(basePrompt, insights)
    // Summarize-request must itself fit the window (system slot + prompt + max out).
    // Insights are best-effort: when they push the request over the window,
    // drop them instead of failing compaction (the summary still fits).
    const summaryPrompt =
      withMemory !== basePrompt &&
      Token.estimate(SUMMARIZATION_SYSTEM_PROMPT) + Token.estimate(withMemory) + summaryOutput > context
        ? basePrompt
        : withMemory
    if (Token.estimate(SUMMARIZATION_SYSTEM_PROMPT) + Token.estimate(summaryPrompt) + summaryOutput > context)
      return false

    let calls = 0
    let errors: string[] = []
    const summarize = (promptText: string, selectionOnly = false) =>
      Effect.gen(function* () {
        calls += 1
        if (calls > MAX_SUMMARIZE_CALLS) return undefined
        const chunks: string[] = []
        let failed = false
        yield* dependencies.llm
          .stream(
            LLM.request({
              model: input.model,
              system: [SystemPart.make(selectionOnly ? SELECTION_ONLY_SYSTEM_PROMPT : SUMMARIZATION_SYSTEM_PROMPT)],
              messages: [Message.user(promptText)],
              tools: [],
              generation: { maxTokens: selectionOnly ? Math.min(summaryOutput, 256) : summaryOutput },
              cache: "none",
            }),
          )
          .pipe(
            Stream.runForEach((event) => {
              if (LLMEvent.is.providerError(event)) failed = true
              if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
              return Effect.void
            }),
            Effect.catchTag("LLM.Error", () => Effect.void),
          )
        const text = chunks.join("")
        return failed || text.trim() === "" ? undefined : text
      })

    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason,
    })

    // Correction loop: 1 initial attempt + select.retry corrections. The first
    // successful full summarize caches the summary (D15: reselection never
    // redoes the summary). Selection-only correction prompts are used ONLY
    // when a non-empty summary is already cached — otherwise retry the full
    // summarizer prompt (avoids empty-summary → silent return false).
    let summary = ""
    let cachedSummary: string | undefined
    let selectedLabels: readonly string[] = []
    let selectionValid = false
    let lastFailure: "none" | "format" | "invalid" | "overBudget" = "none"
    let degraded = false
    const selectionRounds = config.selectEnabled ? 1 + config.selectRetry : 0
    for (let round = 0; round < selectionRounds; round++) {
      const hasSummary = cachedSummary !== undefined && cachedSummary.trim() !== ""
      // Selection-only only after we already have a real summary to keep (D15).
      const selectionOnly = round > 0 && hasSummary
      const promptText = selectionOnly ? correctionPromptFor(errors, numbered) : summaryPrompt
      const output = yield* summarize(promptText, selectionOnly)
      if (output === undefined) {
        // No model text: retry with full prompt while we lack a summary; once
        // we already cached one, further LLM failures degrade to Pi fallback.
        if (!hasSummary && round + 1 < selectionRounds) continue
        degraded = true
        break
      }
      const parsed = parseSelection(output)
      if (!hasSummary && parsed.ok) {
        const stripped = stripSelection(output)
        // Never cache "" from a selection-only / selection-tag-only response —
        // that would skip degrade and return false below.
        if (stripped.trim() !== "") cachedSummary = stripped
      }
      if (!parsed.ok) {
        lastFailure = "format"
        errors = [...parsed.errors]
        continue
      }
      const validated = validateSelection({
        selected: parsed.selected,
        items: selected.items,
        limit: selectionLimit,
        maxItems,
      })
      if (validated.ok) {
        // Up to 1.5x the limit is fully kept (D9 first branch); never truncate.
        // An empty selection is a legitimate zero-selection outcome (P0-1).
        selectionValid = true
        selectedLabels = validated.selected
        break
      }
      if (validated.overBudget) {
        // Remember the attempt so a second over-budget round can be greedily
        // packed instead of degrading; keep the error for the correction prompt.
        lastFailure = "overBudget"
        selectedLabels = validated.selected ?? []
        errors = [...validated.errors]
        continue
      }
      lastFailure = "invalid"
      errors = [...validated.errors]
    }
    // Empty/missing summary must Pi-degrade — never publish an empty checkpoint.
    if (cachedSummary === undefined || cachedSummary.trim() === "") degraded = true

    if (!degraded && selectedLabels.length > 0) {
      // D9: only when the final selection still exceeds 1.5x the (total-budget-
      // tightened) selection limit, pack largest-first down to the limit.
      // ≤1.5x is fully kept at this step; the hard window cap is enforced below
      // once the actual summary size is known.
      const chosen = selected.items.filter((item) => selectedLabels.includes(item.label))
      const chosenTokens = chosen.reduce((sum, item) => sum + item.tokens, 0)
      if (chosenTokens > selectionLimit * 1.5) {
        selectedLabels = packLargestFirst(chosen, selectionLimit)
      }
    }

    if (degraded || (!selectionValid && lastFailure !== "overBudget")) {
      // Pi-style fallback: summarize the full head without numbered selection.
      // Triggered by consecutive format/unknown-number failures (D10) or summary
      // failures. Over-budget selections are NOT degraded (they go through
      // greedy packing), and a valid zero-selection is not degraded either.
      // Insights enter the degrade prompt only when they survived the fit
      // check (summaryPrompt === basePrompt means they were dropped).
      const degradePrompt = withInsights(
        buildPrompt({
          previousSummary,
          context: [head].filter(Boolean),
        }),
        summaryPrompt === basePrompt ? "" : insights,
      )
      const output = yield* summarize(degradePrompt)
      if (output === undefined) return false
      // The system prompt still asks for a <selection> tag; strip it so the
      // degraded summary stays clean even when the model emits an empty one.
      summary = stripSelection(output)
      selectedLabels = []
    } else {
      summary = cachedSummary ?? ""
    }

    if (summary.trim() === "") return false
    const filesXml = renderFilesXml(fileOps)
    const summaryText = filesXml === "" ? summary : `${summary}\n\n${filesXml}`
    // Hard total-budget cap (P1-4 full form) after the real summary size is known:
    // summary + selected + recent + system/tools ≤ context − buffer.
    // Recent stays; selected shrinks via largest-first packing if still over.
    if (selectedLabels.length > 0) {
      const residual = selectedBudgetCap({
        contextWindow: context,
        buffer: bufferTokens,
        summaryTokens: Token.estimate(summaryText),
        recentTokens,
        systemToolsTokens,
      })
      const chosen = selected.items.filter((item) => selectedLabels.includes(item.label))
      const chosenTokens = chosen.reduce((sum, item) => sum + item.tokens, 0)
      if (chosenTokens > residual) {
        selectedLabels = packLargestFirst(chosen, residual)
      }
    }
    // Survival accounting: selected items and recent-turn items get +1; items
    // that were neither selected nor recent disappear from the map.
    const nextSurvival: Record<string, number> = {}
    for (const label of selectedLabels) {
      const item = selected.items.find((candidate) => candidate.label === label)
      if (item) nextSurvival[item.key] = (previousSurvival[item.key] ?? 0) + 1
    }
    for (const turn of selected.recent) {
      nextSurvival[turn.key] = (previousSurvival[turn.key] ?? 0) + 1
    }
    // Selected items and the recent region are kept verbatim in the replayed
    // context (design §6: summary + selected verbatim + recent). `kept` records
    // their message IDs; `keptFrom` is the earliest kept seq so the history
    // loader can read them back and filter out unselected head messages.
    const keptIDs = [
      ...selectedLabels.flatMap((label) => {
        const item = selected.items.find((candidate) => candidate.label === label)
        return item ? item.entries.map((entry) => entry.message.id) : []
      }),
      ...selected.recent.flatMap((turn) => turn.entries.map((entry) => entry.message.id)),
    ]
    const kept = [...new Set(keptIDs)]
    const keptFrom = kept.length === 0
      ? undefined
      : Math.min(
          ...kept
            .map((id) => input.entries.find((entry) => entry.message.id === id)?.seq)
            .filter((seq): seq is number => seq !== undefined),
        )
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason,
      text: summaryText,
      ...(keptFrom === undefined ? {} : { keptFrom }),
      ...(kept.length === 0 ? {} : { kept }),
      survival: nextSurvival,
      ...(fileOps.read.length === 0 && fileOps.modified.length === 0 ? {} : { files: fileOps }),
    })
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    // D13: maxOutput must not participate in the trigger threshold — buffer only.
    const triggerBuffer = config.buffer ?? Math.min(Math.floor(context * 0.1), 20_000)
    if (
      estimate({
        system: input.request.system,
        messages: input.request.compiled?.messages ?? input.request.messages,
        tools: input.request.compiled?.tools ?? input.request.tools,
      }) <=
      context - triggerBuffer
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
