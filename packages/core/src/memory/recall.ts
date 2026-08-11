export * as MemoryRecall from "./recall"

import { Context, Effect, Layer } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { resolveRoots, type MemoryRoots } from "./storage"
import { openConfiguredMemoryIndex, ensureIndexed } from "./reindex"
import { rankResults, filterRecallHits, decayScore, isContentFree, staleNote } from "./ranking"
import { memoryRecallEnvConfig, memoryCitationsMode, type CitationsMode } from "./config"
import { scanForThreats } from "./scan"

export const RECALL_TOP_N = 5
export const RECALL_CHUNK_MAX_CHARS = 600
export const RECALL_BLOCK_MAX_CHARS = 4096
const QUERY_MAX_CHARS = 800
const QUERY_MAX_USERS = 3

/** Derives the recall query from the last few substantive user messages. */
export function recallQuery(messages: ReadonlyArray<{ type: string; text?: string }>): string {
  const users = messages
    .filter((message) => message.type === "user")
    .map((message) => (message.text ?? "").trim())
    .filter((text) => text.length > 0)
    .slice(-QUERY_MAX_USERS)
  if (users.length === 0) return ""
  return users.join(" ").slice(0, QUERY_MAX_CHARS)
}

/** Converts natural-language text into an FTS5 OR-term query (AND semantics rarely match). */
export function ftsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => term.length >= 2)
  if (terms.length === 0) return `"${query}"`
  return terms.join(" OR ")
}

/** Safe path label for model context (never inject raw malicious filenames). */
export function safeRecallPath(pathLabel: string): string {
  if (pathLabel.length === 0 || pathLabel.length > 512) return "[blocked-path]"
  if (/[\u0000-\u001f\u007f]/.test(pathLabel)) return "[blocked-path]"
  if (scanForThreats(pathLabel).length > 0) return "[blocked-path]"
  return pathLabel
}

/** Renders the top hits as a bounded, citation-carrying markdown block. */
export function formatRecallBlock(
  hits: ReadonlyArray<{ path: string; text: string; source?: string; ageDays?: number }>,
  mode: CitationsMode,
): string {
  if (mode === "off" || hits.length === 0) return ""
  const lines = hits.map((hit) => {
    const note = staleNote(hit.ageDays ?? 0, (hit.source ?? "workspace") as "global" | "workspace" | "session")
    const text = `${hit.text.slice(0, RECALL_CHUNK_MAX_CHARS)} ${note}`.trim()
    return `- ${safeRecallPath(hit.path)}: ${text}`
  })
  return `## Relevant memory\n${lines.join("\n")}`.slice(0, RECALL_BLOCK_MAX_CHARS)
}

/** Per-session cache: same query within a process skips re-open/index/search. */
const recallBlockCache = new Map<string, { query: string; block: string; at: number }>()

/** Invalidate recall cache after consolidate/reindex so new memory is visible. */
let recallEpoch = 0

/** Bump when memory content may have changed (consolidate, reindex, import). */
export function invalidateRecallCache(): void {
  recallEpoch++
  recallBlockCache.clear()
}

/** Test-only: clear the recall cache. */
export function resetRecallCacheForTests(): void {
  recallBlockCache.clear()
  recallEpoch = 0
}

/**
 * Retrieval-only recall pipeline: recent user messages -> query -> index
 * search -> rank -> threat-filter -> top-N block. Never writes memory files
 * and never invokes the LLM; every failure degrades to an empty block.
 * Included hits bump access_count.
 *
 * Cached by session+query so prepare() that reloads system context on every
 * turn does not re-open the index when user messages (and thus the query) are
 * unchanged.
 */
export const buildRecallBlock = Effect.fn("Memory.buildRecallBlock")(function* (
  store: SessionStore.Interface,
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  sessionID: SessionSchema.ID,
) {
  const mode = memoryCitationsMode()
  if (mode === "off") return ""
  const query = yield* store.context(sessionID).pipe(
    Effect.map(recallQuery),
    Effect.catch(() => Effect.succeed("")),
  )
  if (query === "") return ""
  const cacheKey = `${recallEpoch}:${mode}:${String(sessionID)}`
  const cached = recallBlockCache.get(cacheKey)
  // Cap cache lifetime so consolidations from other processes still surface.
  const CACHE_TTL_MS = 60_000
  if (cached !== undefined && cached.query === query && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.block
  }

  const index = yield* openConfiguredMemoryIndex(fs, roots).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (index === undefined) return ""
  try {
    yield* ensureIndexed(index, fs, roots).pipe(Effect.catch(() => Effect.void))
    const hits = yield* index.search(ftsQuery(query), RECALL_TOP_N * 4).pipe(Effect.catch(() => Effect.succeed([])))
    const cfg = memoryRecallEnvConfig()
    const kept = filterRecallHits(
      rankResults(hits).map((hit) => ({
        ...hit,
        // rankResults sorts by decayed score but returns original scores; recompute so minScore is consistent with ranking
        score: decayScore(hit.score, hit.ageDays, hit.source as "global" | "workspace" | "session"),
      })),
      cfg,
    )
      .filter((hit) => !isContentFree(hit.text))
      .filter((hit) => scanForThreats(hit.text).length === 0)
      .filter((hit) => scanForThreats(hit.path).length === 0)
      .slice(0, RECALL_TOP_N)
    yield* index
      .incrementAccess(kept.map((hit) => ({ id: hit.id, source: hit.source, root: hit.root })))
      .pipe(Effect.catch(() => Effect.void))
    const block = formatRecallBlock(kept, mode)
    recallBlockCache.set(cacheKey, { query, block, at: Date.now() })
    return block
  } finally {
    yield* index.close().pipe(Effect.catch(() => Effect.void))
  }
})

export interface Interface {
  readonly recall: (sessionID: SessionSchema.ID) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryRecall") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    return Service.of({
      recall: Effect.fn("Memory.recall")(function* (sessionID) {
        const roots = resolveRoots(path.join(global.data, "memory"), location.directory)
        return yield* buildRecallBlock(store, fs, roots, sessionID)
      }),
    })
  }),
)

export const node = makeLocationNode({
  name: "memory-recall",
  layer,
  deps: [SessionStore.node, FSUtil.node, Global.node, Location.node],
})
