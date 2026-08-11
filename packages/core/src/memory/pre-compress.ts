/**
 * Pre-compress insight extraction.
 *
 * Pulls durable facts (decisions, file paths, errors) from the messages that
 * are about to leave the context window, so the compaction summary (Task 9)
 * can re-inject them. V1 is fully deterministic — no LLM — to avoid double
 * token burn with flush. An optional LLM refinement pass can be layered on
 * later via `PRECOMPRESS_SYSTEM` (see prompts.ts), gated on the
 * OPENCODE_MEMORY_PRECOMPRESS env var (read by the compaction wiring).
 *
 * Output contract (deterministic):
 *
 *   ## Pre-compress insights
 *
 *   - [path] <line>
 *   - [decision] <line>
 *   - [error] <line>
 *
 * Path bullets come first (paths are the highest-value durable facts), each
 * label in first-appearance order. Candidate lines are the last
 * PRECOMPRESS_WINDOW user messages and the last PRECOMPRESS_WINDOW assistant
 * messages; threatened lines are dropped; lines longer than
 * PRECOMPRESS_MAX_LINE are treated as tool-output noise; output is capped at
 * PRECOMPRESS_CAP_CHARS (earliest bullets win); "" when nothing durable or
 * below PRECOMPRESS_NOISE_CHARS of collected text.
 */
import { scanForThreats } from "./scan"

/** Cap for the assembled output (RECOMPRESS-style 4k budget). */
export const PRECOMPRESS_CAP_CHARS = 4000

/** How many trailing user (and assistant) messages each to consider. */
export const PRECOMPRESS_WINDOW = 3

/** Total collected bullet text below this is treated as noise. */
export const PRECOMPRESS_NOISE_CHARS = 8

/** Single lines longer than this are tool-output noise, not durable facts. */
export const PRECOMPRESS_MAX_LINE = 240

/** Punct / emoji-only lines (e.g. "…", "👍") are never durable. */
const NOISE_LINE_RE = /^[\s\p{P}\p{S}]+$/u

/** File-path-like lines: an extension with a path-ish prefix, or a src/ chain. */
const PATH_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|go|md|json|ya?ml|toml|sh|sql)\b|\bsrc\/(?:[\w.-]+\/)*[\w.-]+/i

/** Decision-like lines. */
const DECISION_RE = /\b(?:decided|decision|chosen|fixed|resolved|agreed)\b|\bwe will\b|\bconclusion\b|\bthe plan is\b/i

/** Error-like lines. */
const ERROR_RE = /\b(?:error|failed|failure|panic|exception)\b/i

type Label = "path" | "decision" | "error"

export function extractPreCompressInsights(
  entries: ReadonlyArray<{ message: { type: string; text?: string; content?: unknown } }>,
): string {
  const labeled = classifyLines(collectLines(entries))
  if (labeled.length === 0) return ""
  if (labeled.reduce((total, { line }) => total + line.length, 0) < PRECOMPRESS_NOISE_CHARS) return ""
  return formatOutput(labeled)
}

function collectLines(entries: ReadonlyArray<{ message: { type: string; text?: string; content?: unknown } }>): string[] {
  const indexed = entries.map((entry, i) => ({ i, message: entry.message }))
  const users = indexed.filter(({ message }) => message.type === "user").slice(-PRECOMPRESS_WINDOW)
  const assistants = indexed.filter(({ message }) => message.type === "assistant").slice(-PRECOMPRESS_WINDOW)
  return [...users, ...assistants]
    .sort((a, b) => a.i - b.i)
    .flatMap(({ message }) => splitLines(messageText(message)))
}

function messageText(message: { type: string; text?: string; content?: unknown }): string {
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) {
    return message.content.map(partText).filter((text) => text !== null).join("\n")
  }
  return message.text ?? ""
}

function partText(part: unknown): string | null {
  if (typeof part === "string") return part
  if (typeof part !== "object" || part === null) return null
  const text = (part as Record<string, unknown>).text
  return typeof text === "string" ? text : null
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        line.length <= PRECOMPRESS_MAX_LINE &&
        !NOISE_LINE_RE.test(line) &&
        scanForThreats(line).length === 0,
    )
}

const LABEL_RANK: Record<Label, number> = { path: 0, decision: 1, error: 2 }

function classifyLines(lines: string[]): Array<{ label: Label; line: string }> {
  const seen = new Set<string>()
  const labeled: Array<{ label: Label; line: string }> = []
  for (const line of lines) {
    if (seen.has(line)) continue
    seen.add(line)
    const label = classify(line)
    if (label) labeled.push({ label, line })
  }
  return labeled.toSorted((a, b) => LABEL_RANK[a.label] - LABEL_RANK[b.label])
}

function classify(line: string): Label | null {
  if (PATH_RE.test(line)) return "path"
  if (DECISION_RE.test(line)) return "decision"
  if (ERROR_RE.test(line)) return "error"
  return null
}

function formatOutput(labeled: Array<{ label: Label; line: string }>): string {
  const header = "## Pre-compress insights\n\n"
  let output = header + labeled.map(({ label, line }) => `- [${label}] ${line}`).join("\n")
  while (output.length > PRECOMPRESS_CAP_CHARS) {
    const lastBreak = output.lastIndexOf("\n")
    if (lastBreak <= header.length) return output.slice(0, PRECOMPRESS_CAP_CHARS)
    output = output.slice(0, lastBreak)
  }
  return output
}
