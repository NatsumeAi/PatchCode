export * as MemoryPreCompress from "./pre-compress-wire"

import { Context, Effect, Layer } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { writeCandidate } from "./candidates"
import { extractPreCompressInsights } from "./pre-compress"
import { sanitizeSessionId } from "./session-logs"
import { resolveRoots, type MemoryRoots } from "./storage"

/**
 * Env gate for pre-compress insight extraction. Unset or any value other
 * than "0" enables the feature; set `OPENCODE_MEMORY_PRECOMPRESS=0` to
 * disable without touching the memory wiring.
 */
const preCompressEnabled = (): boolean => process.env.OPENCODE_MEMORY_PRECOMPRESS !== "0"

type InsightEntry = { readonly message: { type: string; text?: string; content?: unknown } }

/**
 * Best-effort pre-compress extractor with services already resolved:
 * extracts durable insights from the entries about to leave the context
 * window, writes them as a memory candidate (so consolidation sees them even
 * when the summary drops them), and returns the insights markdown for the
 * compaction summary prompt. Every failure degrades to "" — never blocks or
 * fails compaction.
 */
export const extractInsightsIfWired = Effect.fn("Memory.extractPreCompressInsightsIfWired")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  entries: ReadonlyArray<InsightEntry>,
  sessionID: string,
) {
  if (!preCompressEnabled()) return ""
  const insights = extractPreCompressInsights(entries)
  if (insights.trim() === "") return ""
  // Per-session-per-day id plus a content hash so a second compaction of the
  // same session the same day with different insights writes a distinct
  // candidate instead of overwriting the first; identical extractions stay
  // idempotent (mirrors delegation-memory.ts hash8).
  const hash = new Bun.CryptoHasher("sha256").update(insights).digest("hex").slice(0, 8)
  const id = `precompress-${sanitizeSessionId(sessionID)}-${new Date().toISOString().slice(0, 10)}-${hash}`
  yield* writeCandidate(fs, roots, id, insights).pipe(Effect.catch(() => Effect.void))
  return insights
})

export interface Interface {
  readonly extract: (
    entries: ReadonlyArray<InsightEntry>,
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryPreCompress") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    return Service.of({
      extract: (entries, sessionID) =>
        // Catch-all guard: every failure degrades to "" so pre-compress
        // never breaks or blocks compaction.
        extractInsightsIfWired(
          fs,
          resolveRoots(path.join(global.data, "memory"), location.directory),
          entries,
          String(sessionID),
        ).pipe(Effect.catch(() => Effect.succeed(""))),
    })
  }),
)

export const node = makeLocationNode({
  name: "memory-pre-compress",
  layer,
  deps: [FSUtil.node, Global.node, Location.node],
})
