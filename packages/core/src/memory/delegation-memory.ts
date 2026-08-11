import { Effect } from "effect"
import { FSUtil } from "../fs-util"
import { writeCandidate } from "./candidates"
import { scanForThreats } from "./scan"
import { sanitizeSessionId } from "./session-logs"
import type { MemoryRoots } from "./storage"

/** Truncation caps applied to the stored observation body. */
export const TASK_CAP_CHARS = 4_000
export const RESULT_CAP_CHARS = 8_000

/** Marker appended when a body was truncated at its cap. */
export const TRUNCATE_MARKER = "\n\n[truncated]"

/** First 8 hex chars of a sha256 of `text` — stable short id for a result body. */
const hash8 = (text: string): string => {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(text)
  return hasher.digest("hex").slice(0, 8)
}

const cap = (text: string, limit: number): string =>
  text.length > limit ? text.slice(0, limit) + TRUNCATE_MARKER : text

const buildObservation = (input: {
  parentSessionID: string
  childSessionID: string
  task: string
  result: string
  ok: boolean
}): string =>
  [
    "## Subagent observation",
    `parent: ${input.parentSessionID}`,
    `child: ${input.childSessionID}`,
    `ok: ${input.ok}`,
    "",
    "### Task",
    cap(input.task, TASK_CAP_CHARS),
    "",
    "### Result",
    cap(input.result, RESULT_CAP_CHARS),
  ].join("\n")

/**
 * Persists a subagent completion (task + result) as a memory candidate so the
 * next consolidation (dream) can merge what delegated agents learned. Returns
 * `true` when a candidate was written, `false` when skipped (empty body,
 * threat patterns, or atomic write failure).
 */
export const writeDelegationObservation = Effect.fn("Memory.writeDelegationObservation")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  input: {
    parentSessionID: string
    childSessionID: string
    task: string
    result: string
    ok: boolean
  },
) {
  const task = input.task.trim()
  const result = input.result.trim()
  if (task === "" || result === "") {
    yield* Effect.logInfo("memory delegation observation skipped: empty task or result")
    return false
  }
  const threatIds = scanForThreats(task).concat(scanForThreats(result))
  if (threatIds.length > 0) {
    yield* Effect.logWarning("memory delegation observation dropped: threat patterns " + threatIds.join(", "))
    return false
  }
  // Id derived from child session + result hash: repeat notifications for the
  // same child and result overwrite the same candidate path instead of spamming.
  const id = `deleg-${sanitizeSessionId(input.childSessionID)}-${hash8(result)}`
  const content = buildObservation({ ...input, task, result })
  return yield* writeCandidate(fs, roots, id, content)
})
