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
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
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
  readonly tokens: number
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
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
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
      tokens: current.keep?.tokens ?? result.tokens,
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
      tokens: DEFAULT_KEEP_TOKENS,
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
    if (parts.length === 0) return { ok: false, errors: ["empty <selection>"] }
    return { ok: true, selected: parts }
  }
  if (!Array.isArray(parsed)) return { ok: false, errors: ["<selection> is not an array"] }
  const selected = parsed.map((item) => String(item))
  if (selected.length === 0) return { ok: false, errors: ["empty <selection>"] }
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
    return { ok: false, errors, overBudget: true, selectedTokens: tokens }
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
  if (input.numberedItems) parts.push(`<numbered-context>\n${input.numberedItems}\n</numbered-context>`)
  return parts.join("\n\n")
}

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
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const recentBudget = Math.min(Math.floor(context * config.keepRecentRatio), config.keepRecentMax)
    const selectionLimit = Math.floor(context * config.selectBudget)
    const maxItems = context >= 1_000_000 ? 20 : 10
    const selected = selectTurns(input.entries, recentBudget, selectionLimit)
    const previousCompaction = input.entries.findLast((entry) => entry.message.type === "compaction")?.message
    const previousSummary = previousCompaction?.type === "compaction" ? previousCompaction.summary : undefined
    const previousSurvival =
      previousCompaction?.type === "compaction" ? (previousCompaction.survival ?? {}) : {}
    const previousFiles = previousCompaction?.type === "compaction" ? previousCompaction.files : undefined
    const fileOps = extractFileOps(input.entries.map((entry) => entry.message), previousFiles)
    const head = renderTurns(selected.head)
    const recent = renderTurns(selected.recent)
    if (head.length === 0 && previousCompaction?.type !== "compaction") return false
    const numbered = formatNumberedItems(selected.items, context, previousSurvival)
    const fullHistory = [head, recent].filter(Boolean)
    const summaryOutput = summaryBudget(context, config.summaryL, config.summaryK)
    const basePrompt = buildPrompt({ previousSummary, numberedItems: numbered, context: fullHistory })
    if (Token.estimate(basePrompt) > context - summaryOutput) return false

    let calls = 0
    let errors: string[] = []
    const summarize = (promptText: string) =>
      Effect.gen(function* () {
        calls += 1
        if (calls > MAX_SUMMARIZE_CALLS) return undefined
        const chunks: string[] = []
        let failed = false
        yield* dependencies.llm
          .stream(
            LLM.request({
              model: input.model,
              system: [SystemPart.make(SUMMARIZATION_SYSTEM_PROMPT)],
              messages: [Message.user(promptText)],
              tools: [],
              generation: { maxTokens: summaryOutput },
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
      reason: "auto",
    })

    // Correction loop: 1 initial attempt + select.retry corrections, then
    // greedy truncation, then the Pi-style fallback (recent + full summary).
    // When select is disabled the loop is skipped entirely.
    let summary = ""
    let selectedLabels: readonly string[] = []
    let degraded = false
    const selectionRounds = config.selectEnabled ? 1 + config.selectRetry : 0
    for (let round = 0; round < selectionRounds; round++) {
      const promptText =
        round === 0
          ? basePrompt
          : `${basePrompt}\n\n<correction>\n${errors.join("\n")}\n</correction>`
      const output = yield* summarize(promptText)
      if (output === undefined) {
        // One summary-failure retry uses the same prompt; a second failure
        // falls back to the Pi-style degrade below.
        if (round === 0) continue
        degraded = true
        break
      }
      const parsed = parseSelection(output)
      if (!parsed.ok) {
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
        selectedLabels = validated.selected
        summary = stripSelection(output)
        break
      }
      errors = [...validated.errors]
    }
    if (summary === "" && selectedLabels.length === 0 && !degraded) degraded = true

    if (!degraded && selectedLabels.length > 0) {
      // Greedy truncation when the accepted selection still exceeds the limit.
      const chosen = selected.items.filter((item) => selectedLabels.includes(item.label))
      let chosenTokens = chosen.reduce((sum, item) => sum + item.tokens, 0)
      if (chosenTokens > selectionLimit) {
        const byTokens = [...chosen].sort((a, b) => b.tokens - a.tokens)
        for (const item of byTokens) {
          if (chosenTokens <= selectionLimit) break
          selectedLabels = selectedLabels.filter((label) => label !== item.label)
          chosenTokens -= item.tokens
        }
      }
    }

    if (degraded || summary === "") {
      // Pi-style fallback: summarize the full head without numbered selection.
      const degradePrompt = buildPrompt({
        previousSummary,
        context: [head].filter(Boolean),
      })
      const output = yield* summarize(degradePrompt)
      if (output === undefined) return false
      // The system prompt still asks for a <selection> tag; strip it so the
      // degraded summary stays clean even when the model emits an empty one.
      summary = stripSelection(output)
      selectedLabels = []
    }

    if (summary.trim() === "") return false
    const filesXml = renderFilesXml(fileOps)
    const summaryText = filesXml === "" ? summary : `${summary}\n\n${filesXml}`
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
      reason: "auto",
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
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    // Trigger buffer per design §3: min(10% window, 20k) unless explicitly configured.
    const triggerBuffer = config.buffer ?? Math.min(Math.floor(context * 0.1), 20_000)
    if (
      estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <=
      context - Math.max(output, triggerBuffer)
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
