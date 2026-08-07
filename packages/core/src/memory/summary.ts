import { Effect } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { readTextSafe, type MemoryRoots } from "./storage"
import { scanForThreats, BLOCK_PLACEHOLDER } from "./scan"

export const SUMMARY_BUDGETS = { global: 1500 * 4, workspace: 1000 * 4 }

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
