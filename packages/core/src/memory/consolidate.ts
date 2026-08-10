export * as MemoryConsolidation from "./consolidate"

import { Context, Effect, Fiber, Layer, Schedule, Stream } from "effect"
import path from "path"
import { LLM, LLMClient, LLMEvent, Message, SystemPart, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import type { Model } from "@opencode-ai/llm"
import { DateTime, Duration } from "effect"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { SessionRunnerModel } from "../session/runner/model"
import { SessionV2 } from "../session"
import { SessionSchema } from "../session/schema"
import { ProjectV2 } from "../project"
import { AbsolutePath } from "../schema"
import { resolveRoots } from "./storage"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"
import { NOISE_FLOOR_CHARS } from "./candidates"
import { listMergeSources, budgetSources, deleteSources, type MergeSource } from "./sources"
import { appendMergedHashes, contentHash, isAlreadyMerged, loadMergedHashes } from "./merged-hashes"
import type { IndexChunk } from "./reindex"
import { acquireMergeLock, releaseMergeLock, markConsolidated, refreshMergeLock, shouldConsolidate } from "./merge-lock"
import { DREAM_SYSTEM } from "./prompts"
import { PRUNE_SYSTEM, selectPruneCandidates } from "./prune"
import { openMemoryIndex } from "./reindex"
import { regenerateSummary } from "./summary"
import { scanForThreats } from "./scan"

const MEMORY_CAP_CHARS = 64 * 1024
const MERGE_INPUT_CAP_CHARS = 32 * 1024

export interface MergeInput {
  readonly fs: FSUtil.Interface
  readonly roots: MemoryRoots
  readonly llm: LLMClientShape
  readonly model: Model
}

const memoryBase = (roots: MemoryRoots) => roots.workspaceDir ?? roots.globalDir
const memoryPath = (roots: MemoryRoots) => path.join(memoryBase(roots), "MEMORY.md")

const streamText = (llm: LLMClientShape, request: LLMRequest) =>
  llm.stream(request).pipe(
    Stream.filter(LLMEvent.is.textDelta),
    Stream.map((event) => event.text),
    Stream.mkString,
    Effect.catch(() => Effect.succeed("")),
  )

const formatSourceBlock = (source: MergeSource): string =>
  `### SOURCE ${source.id}\n${source.text}`

/**
 * Merges budgeted sources into MEMORY.md via the dream LLM. Idempotent via
 * `merged.hashes`. Source files are deleted only after a successful atomic write
 * and ledger append.
 */
export const mergeCandidates = Effect.fn("Memory.mergeCandidates")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  llm: LLMClientShape,
  model: Model,
  contents: ReadonlyArray<MergeSource>,
  pruneList: ReadonlyArray<{ chunkId: string; path: string; excerpt: string }> = [],
) {
  const base = memoryBase(roots)
  const target = memoryPath(roots)
  const existing = (yield* readTextSafe(fs, target)) ?? ""
  const ledger = yield* loadMergedHashes(fs, base)

  const pending: Array<MergeSource> = []
  const already: Array<MergeSource> = []
  for (const source of contents) {
    if (isAlreadyMerged(ledger, source.id, source.text)) {
      already.push(source)
      continue
    }
    pending.push(source)
  }
  // Duplicate sources already recorded in the ledger can be cleaned up.
  if (already.length > 0) yield* deleteSources(fs, already)
  if (pending.length === 0) return false

  const { included } = budgetSources(pending, MERGE_INPUT_CAP_CHARS)
  if (included.length === 0) return false

  const input = included.map(formatSourceBlock).join("\n\n---\n\n")
  const boundedPruneList = pruneList.slice(0, 200)
  const pruneSection =
    boundedPruneList.length > 0
      ? `\n\nPRUNE LIST (chunk excerpts to remove if no longer relevant):\n${boundedPruneList
          .map((item) => `- ${item.chunkId} (${item.path}): ${item.excerpt}`)
          .join("\n")}\n`
      : ""
  const system = boundedPruneList.length > 0 ? `${DREAM_SYSTEM}\n\n${PRUNE_SYSTEM}` : DREAM_SYSTEM
  const request = LLM.request({
    model,
    system: [SystemPart.make(system)],
    messages: [
      Message.user(
        `EXISTING MEMORY:\n${existing.slice(0, MEMORY_CAP_CHARS)}\n\nSOURCES:\n${input.slice(0, MERGE_INPUT_CAP_CHARS)}${pruneSection}`,
      ),
    ],
    tools: [],
  })
  const merged = (yield* streamText(llm, request)).trim()
  if (merged.length === 0 || merged === "NO_REPLY") {
    yield* Effect.logInfo("memory consolidate: LLM returned empty or NO_REPLY; sources kept")
    return false
  }
  if (merged.length > MEMORY_CAP_CHARS) {
    yield* Effect.logWarning("memory consolidate: merged archive over cap; sources kept")
    return false
  }
  if (scanForThreats(merged).length > 0) {
    yield* Effect.logWarning("memory consolidate: threat patterns in LLM output; sources kept")
    return false
  }

  const written = yield* writeTextAtomic(fs, target, merged)
  if (!written) {
    yield* Effect.logWarning("memory consolidate: atomic MEMORY.md write failed; sources kept")
    return false
  }

  const hashes = included.map((source) => contentHash(source.id, source.text))
  const ledgerOk = yield* appendMergedHashes(fs, base, hashes)
  if (!ledgerOk) {
    yield* Effect.logWarning("memory consolidate: hash ledger append failed; sources still deleted after MEMORY write")
  }
  yield* deleteSources(fs, included)
  return true
})

/** Gated consolidation: lock + min interval + noise/threat filtering + merge + summary regen. */
export const runConsolidation = Effect.fn("Memory.runConsolidation")(function* (input: MergeInput) {
  const { fs, roots, llm, model } = input
  const locked = yield* acquireMergeLock(fs, roots)
  if (!locked) return
  try {
    if (!(yield* shouldConsolidate(fs, roots))) return
    // Heartbeat: refresh the lock every 5 minutes so a long LLM merge cannot be
    // reclaimed as stale by a concurrent process (STALE_LOCK_SECS = 3600). The
    // fiber is explicitly interrupted when the consolidation body finishes —
    // this Effect version does not interrupt forkScoped children when the
    // parent Effect.scoped closes, so a plain fork would leak past the run and
    // recreate the lock after release (blocking all future consolidations).
    const heartbeat = yield* Effect.scoped(
      Effect.gen(function* () {
        return yield* refreshMergeLock(fs, roots).pipe(
          Effect.repeat(Schedule.spaced(Duration.minutes(5))),
          Effect.forkScoped,
        )
      }),
    )
    try {
      const sources = yield* listMergeSources(fs, roots)
      const contents: Array<MergeSource> = []
      for (const source of sources) {
        if (source.text.trim().length < NOISE_FLOOR_CHARS) {
          yield* deleteSources(fs, [source])
          continue
        }
        if (scanForThreats(source.text).length > 0) {
          yield* deleteSources(fs, [source])
          continue
        }
        contents.push(source)
      }
      if (contents.length === 0) return
      const index = yield* openMemoryIndex(fs, roots).pipe(Effect.catch(() => Effect.succeed(undefined)))
      let pruneList: Array<{ chunkId: string; path: string; excerpt: string }> = []
      if (index !== undefined) {
        try {
          const chunks = yield* index
            .listChunks()
            .pipe(Effect.catch(() => Effect.succeed([] as Array<IndexChunk>)))
          pruneList = selectPruneCandidates(
            chunks.map((chunk) => ({
              chunkId: String(chunk.id),
              path: chunk.path,
              excerpt: chunk.text.slice(0, 200),
              accessCount: chunk.accessCount,
              mtimeMs: chunk.mtimeMs,
            })),
            Date.now(),
          )
        } finally {
          yield* index.close().pipe(Effect.catch(() => Effect.void))
        }
      }
      const merged = yield* mergeCandidates(fs, roots, llm, model, contents, pruneList)
      if (merged) {
        yield* markConsolidated(fs, roots)
        yield* regenerateSummary(fs, roots, llm, model)
      }
    } finally {
      yield* Fiber.interrupt(heartbeat).pipe(Effect.catch(() => Effect.void))
    }
  } finally {
    yield* releaseMergeLock(fs, roots)
  }
})

/**
 * Dual-root orchestration: when a workspace is open, consolidate workspace
 * memory and pure-global memory independently (separate base dirs / locks).
 */
export const runDualRootConsolidation = Effect.fn("Memory.runDualRootConsolidation")(function* (input: {
  readonly fs: FSUtil.Interface
  readonly globalDir: string
  readonly projectDirectory: string | undefined
  readonly llm: LLMClientShape
  readonly model: Model
}) {
  const roots = resolveRoots(input.globalDir, input.projectDirectory)
  yield* runConsolidation({ fs: input.fs, roots, llm: input.llm, model: input.model })
  if (roots.workspaceDir !== undefined) {
    yield* runConsolidation({
      fs: input.fs,
      roots: { globalDir: roots.globalDir, workspaceDir: undefined },
      llm: input.llm,
      model: input.model,
    })
  }
})

export interface Interface {
  readonly consolidate: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryConsolidation") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const llm = yield* LLMClient.Service
    const models = yield* SessionRunnerModel.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const syntheticSession = SessionV2.Info.make({
      id: SessionSchema.ID.make("ses_memory_consolidation"),
      projectID: ProjectV2.ID.global,
      title: "memory-consolidation",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
      location: { directory: AbsolutePath.make(location.directory) },
    })
    const svc = Service.of({
      consolidate: Effect.fn("Memory.consolidate")(function* () {
        const model = yield* models.resolve(syntheticSession).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!model) return
        yield* runDualRootConsolidation({
          fs,
          globalDir: path.join(global.data, "memory"),
          projectDirectory: location.directory,
          llm,
          model,
        }).pipe(Effect.catch(() => Effect.void))
      }),
    })
    // Periodic trigger: the min_hours gate inside runConsolidation prevents
    // over-runs, so a 30-minute tick only consolidates when due.
    yield* svc.consolidate().pipe(
      Effect.catch(() => Effect.void),
      Effect.repeat(Schedule.spaced(Duration.minutes(30))),
      Effect.forkScoped,
    )
    return svc
  }),
)

export const node = makeLocationNode({
  name: "memory-consolidation",
  layer,
  deps: [llmClient, SessionRunnerModel.node, FSUtil.node, Global.node, Location.node],
})
