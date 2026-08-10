import { Effect, Stream } from "effect"
import path from "path"
import { LLM, LLMClient, LLMEvent, Message, SystemPart, type LLMClientShape } from "@opencode-ai/llm"
import type { Model } from "@opencode-ai/llm"
import { FSUtil } from "../fs-util"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"
import { scanForThreats, BLOCK_PLACEHOLDER } from "./scan"

export const SUMMARY_BUDGETS = { global: 1500 * 4, workspace: 1000 * 4 }

const SUMMARY_SYSTEM =
  "Summarize the memory archive for future sessions. Put the MOST IMPORTANT facts first. Output ONLY markdown."
const SUMMARY_INPUT_CAP_CHARS = 64 * 1024

export interface LoadedSummary {
  readonly global: string
  readonly workspace: string
}

function truncateHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

function sanitize(text: string): string {
  const ids = scanForThreats(text)
  if (ids.length === 0) return text
  return BLOCK_PLACEHOLDER(ids)
}

/** Reads `memory_summary.md` per scope, truncated to budget and threat-scanned. */
export const loadSummaries = Effect.fn("Memory.loadSummaries")(function* (fs: FSUtil.Interface, roots: MemoryRoots) {
  const readScope = (dir: string | undefined, budget: number): Effect.Effect<string, FSUtil.Error> =>
    dir === undefined
      ? Effect.succeed("")
      : readTextSafe(fs, path.join(dir, "memory_summary.md")).pipe(
          Effect.map((text) => (text === undefined ? "" : sanitize(truncateHead(text.trim(), budget)))),
        )
  const global = yield* readScope(roots.globalDir, SUMMARY_BUDGETS.global)
  const workspace = yield* readScope(roots.workspaceDir, SUMMARY_BUDGETS.workspace)
  return { global, workspace }
})

/** Renders the loaded summaries workspace-first with scope headers; empty when nothing loaded. */
export function renderSummaryBlock(loaded: LoadedSummary): string {
  const parts: string[] = []
  if (loaded.workspace) parts.push(`<workspace-memory>\n${loaded.workspace}\n</workspace-memory>`)
  if (loaded.global) parts.push(`<global-memory>\n${loaded.global}\n</global-memory>`)
  return parts.join("\n\n")
}

/**
 * Regenerates `memory_summary.md` from the curated archive via the LLM
 * (threat-scanned). Returns `true` only when the atomic write succeeded.
 */
export const regenerateSummary = Effect.fn("Memory.regenerateSummary")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  llm: LLMClientShape,
  model: Model,
) {
  const base = roots.workspaceDir ?? roots.globalDir
  const archive = yield* readTextSafe(fs, path.join(base, "MEMORY.md"))
  if (archive === undefined || archive.trim() === "") return false
  const request = LLM.request({
    model,
    system: [SystemPart.make(SUMMARY_SYSTEM)],
    messages: [Message.user(archive.slice(0, SUMMARY_INPUT_CAP_CHARS))],
    tools: [],
  })
  const text = yield* llm.stream(request).pipe(
    Stream.filter(LLMEvent.is.textDelta),
    Stream.map((event) => event.text),
    Stream.mkString,
    Effect.catch(() => Effect.succeed("")),
  )
  const cleaned = text.trim()
  if (cleaned.length === 0) return false
  if (scanForThreats(cleaned).length > 0) return false
  return yield* writeTextAtomic(fs, path.join(base, "memory_summary.md"), cleaned.slice(0, SUMMARY_BUDGETS.global))
})