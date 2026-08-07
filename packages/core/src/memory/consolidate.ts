export * as MemoryConsolidation from "./consolidate"

import { Context, Effect, Layer, Stream } from "effect"
import path from "path"
import { LLM, LLMClient, LLMEvent, Message, SystemPart, type LLMClientShape, type LLMRequest } from "@opencode-ai/llm"
import type { Model } from "@opencode-ai/llm"
import { DateTime } from "effect"
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
import { listCandidates, readCandidate, deleteCandidate, mergeKeyOf, NOISE_FLOOR_CHARS } from "./candidates"
import { acquireMergeLock, releaseMergeLock, markConsolidated, shouldConsolidate } from "./merge-lock"
import { PHASE2_SYSTEM } from "./merge-prompt"
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

const memoryPath = (roots: MemoryRoots) => path.join(roots.workspaceDir ?? roots.globalDir, "MEMORY.md")

const streamText = (llm: LLMClientShape, request: LLMRequest) =>
  llm.stream(request).pipe(
    Stream.filter(LLMEvent.is.textDelta),
    Stream.map((event) => event.text),
    Stream.mkString,
    Effect.catch(() => Effect.succeed("")),
  )

/**
 * Merges candidates into MEMORY.md via the LLM. Idempotent: candidates whose
 * merge key already appears in the archive are dropped (and their files
 * deleted); sources are deleted only after a successful write.
 */
export const mergeCandidates = Effect.fn("Memory.mergeCandidates")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  llm: LLMClientShape,
  model: Model,
  contents: ReadonlyArray<{ id: string; text: string }>,
  pruneList: ReadonlyArray<{ chunkId: string; path: string; excerpt: string }> = [],
) {
  const target = memoryPath(roots)
  const existing = (yield* readTextSafe(fs, target)) ?? ""
  const pending: Array<{ id: string; text: string }> = []
  for (const candidate of contents) {
    if (existing.includes(mergeKeyOf(candidate.id, candidate.text))) {
      yield* deleteCandidate(fs, roots, candidate.id)
      continue
    }
    pending.push(candidate)
  }
  if (pending.length === 0) return false

  // Budget the input candidate-by-candidate: only candidates whose text made it
  // into the prompt may be deleted after a successful merge; overflow stays on
  // disk for the next run (idempotency invariant).
  const included: Array<{ id: string; text: string }> = []
  let budget = 0
  for (const candidate of pending) {
    const block = `${mergeKeyOf(candidate.id, candidate.text)}\n${candidate.text}`
    if (budget + block.length > MERGE_INPUT_CAP_CHARS) break
    budget += block.length + 4
    included.push(candidate)
  }
  if (included.length === 0) return false

  const input = included
    .map((candidate) => `${mergeKeyOf(candidate.id, candidate.text)}\n${candidate.text}`)
    .join("\n\n---\n\n")
  const pruneSection =
    pruneList.length > 0
      ? `\n\nPRUNE LIST (chunk excerpts to remove if no longer relevant):\n${pruneList
          .map((item) => `- ${item.chunkId} (${item.path}): ${item.excerpt}`)
          .join("\n")}\n`
      : ""
  const system = pruneList.length > 0 ? `${PHASE2_SYSTEM}\n\n${PRUNE_SYSTEM}` : PHASE2_SYSTEM
  const request = LLM.request({
    model,
    system: [SystemPart.make(system)],
    messages: [
      Message.user(
        `EXISTING MEMORY:\n${existing.slice(0, MEMORY_CAP_CHARS)}\n\nCANDIDATES:\n${input.slice(0, MERGE_INPUT_CAP_CHARS)}${pruneSection}`,
      ),
    ],
    tools: [],
  })
  const merged = (yield* streamText(llm, request)).trim()
  if (merged.length === 0 || merged === "NO_REPLY") return false
  if (merged.length > MEMORY_CAP_CHARS) return false
  if (scanForThreats(merged).length > 0) return false

  yield* writeTextAtomic(fs, target, merged)
  for (const candidate of included) yield* deleteCandidate(fs, roots, candidate.id)
  return true
})

/** Gated consolidation: lock + min interval + noise/threat filtering + merge + summary regen. */
export const runConsolidation = Effect.fn("Memory.runConsolidation")(function* (input: MergeInput) {
  const { fs, roots, llm, model } = input
  const locked = yield* acquireMergeLock(fs, roots)
  if (!locked) return
  try {
    if (!(yield* shouldConsolidate(fs, roots))) return
    const candidates = yield* listCandidates(fs, roots, 0)
    const contents: Array<{ id: string; text: string }> = []
    for (const candidate of candidates) {
      const text = yield* readCandidate(fs, roots, candidate.id)
      if (text === undefined || text.trim().length < NOISE_FLOOR_CHARS) {
        yield* deleteCandidate(fs, roots, candidate.id)
        continue
      }
      if (scanForThreats(text).length > 0) {
        yield* deleteCandidate(fs, roots, candidate.id)
        continue
      }
      contents.push({ id: candidate.id, text })
    }
    if (contents.length === 0) return
    const index = yield* openMemoryIndex(fs, roots).pipe(Effect.catch(() => Effect.succeed(undefined)))
    let pruneList: Array<{ chunkId: string; path: string; excerpt: string }> = []
    if (index !== undefined) {
      try {
        const chunks = yield* index.listChunks().pipe(Effect.catch(() => Effect.succeed([])))
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
    yield* releaseMergeLock(fs, roots)
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
    return Service.of({
      consolidate: Effect.fn("MemoryConsolidation.consolidate")(function* () {
        const model = yield* models.resolve(syntheticSession).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!model) return
        const roots = resolveRoots(path.join(global.data, "memory"), location.directory)
        yield* runConsolidation({ fs, roots, llm, model }).pipe(Effect.catch(() => Effect.void))
      }),
    })
  }),
)

export const node = makeLocationNode({
  name: "memory-consolidation",
  layer,
  deps: [llmClient, SessionRunnerModel.node, FSUtil.node, Global.node, Location.node],
})
