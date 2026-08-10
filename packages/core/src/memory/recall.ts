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
import { rankResults, isContentFree, staleNote } from "./ranking"
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

/** Renders the top hits as a bounded, citation-carrying markdown block. */
export function formatRecallBlock(
  hits: ReadonlyArray<{ path: string; text: string; source?: string; ageDays?: number }>,
): string {
  if (hits.length === 0) return ""
  const lines = hits.map((hit) => {
    const note = staleNote(hit.ageDays ?? 0, (hit.source ?? "workspace") as "global" | "workspace" | "session")
    const text = `${hit.text.slice(0, RECALL_CHUNK_MAX_CHARS)} ${note}`.trim()
    return `- ${hit.path}: ${text}`
  })
  return `## Relevant memory\n${lines.join("\n")}`.slice(0, RECALL_BLOCK_MAX_CHARS)
}

/**
 * Retrieval-only recall pipeline: recent user messages -> query -> index
 * search -> rank -> threat-filter -> top-N block. Never writes memory files
 * and never invokes the LLM; every failure degrades to an empty block.
 * Included hits bump access_count.
 */
export const buildRecallBlock = Effect.fn("Memory.buildRecallBlock")(function* (
  store: SessionStore.Interface,
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  sessionID: SessionSchema.ID,
) {
  const query = yield* store.context(sessionID).pipe(
    Effect.map(recallQuery),
    Effect.catch(() => Effect.succeed("")),
  )
  if (query === "") return ""
  const index = yield* openConfiguredMemoryIndex(fs, roots).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (index === undefined) return ""
  try {
    yield* ensureIndexed(index, fs, roots).pipe(Effect.catch(() => Effect.void))
    const hits = yield* index.search(ftsQuery(query), RECALL_TOP_N * 4).pipe(Effect.catch(() => Effect.succeed([])))
    const kept = rankResults(hits)
      .filter((hit) => !isContentFree(hit.text))
      .filter((hit) => scanForThreats(hit.text).length === 0)
      .slice(0, RECALL_TOP_N)
      .map((hit) => ({ ...hit, source: hit.source, ageDays: hit.ageDays }))
    yield* index
      .incrementAccess(kept.map((hit) => ({ id: hit.id, source: hit.source, root: hit.root })))
      .pipe(Effect.catch(() => Effect.void))
    return formatRecallBlock(kept)
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
