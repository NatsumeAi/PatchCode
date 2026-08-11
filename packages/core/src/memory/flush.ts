export * as MemoryFlush from "./flush"

import { Context, Effect, Layer, Option, Stream } from "effect"
import path from "path"
import { LLM, LLMClient, LLMEvent, SystemPart, type LLMClientShape } from "@opencode-ai/llm"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { SessionRunnerModel } from "../session/runner/model"
import { toLLMMessages } from "../session/runner/to-llm-message"
import { readTextSafe, resolveRoots, writeTextAtomic, type MemoryRoots } from "./storage"
import { appendSessionLog, sessionLogPath, sanitizeSessionId } from "./session-logs"
import { scanForThreats } from "./scan"
import { FLUSH_DELTA_SYSTEM, FLUSH_SYSTEM } from "./prompts"
import { persistFlushStats, recordFlushFailed, recordFlushNoReply, recordFlushSuccess } from "./observability"
import { isNoReply, stripModelWrapper } from "./text-utils"
import { flushContentHash, isFlushDuplicate } from "./flush-dedup"
import { resolveMemoryEmbeddingProvider } from "./config"
import type { EmbeddingProvider } from "./embedding"

export { isNoReply, stripModelWrapper } from "./text-utils"
export { isFlushDuplicate, flushContentHash } from "./flush-dedup"

/** Cap prior flush excerpt included in the delta system prompt (chars). */
const PRIOR_FLUSH_EXCERPT_CAP = 8_000

/** Process-local cooldown so manual + auto compact cannot double-write within a cycle. */
export const FLUSH_COOLDOWN_MS = 5_000

/**
 * Process-local map of last content-flush time per session id.
 * Shared by manual `/compact` (session.ts) and auto-compact (llm.ts) paths so
 * a single compact cycle cannot double-write identical summaries.
 */
const lastFlushBySession = new Map<string, number>()

/** Compaction cycle generation per session (bumped by callers when a new compact starts). */
const flushCycleBySession = new Map<string, number>()
const lastFlushedCycleBySession = new Map<string, number>()

export interface Interface {
  readonly flush: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryFlush") {}

/**
 * Bump the compaction generation for a session. Call once per compact cycle so
 * at most one content flush runs per generation (crosses the 5s cooldown gap).
 */
export function beginFlushCycle(sessionID: string): number {
  const next = (flushCycleBySession.get(sessionID) ?? 0) + 1
  flushCycleBySession.set(sessionID, next)
  return next
}

/**
 * Returns true when this session may content-flush: not within cooldown AND
 * not already flushed for the current compaction generation (if any).
 */
export function shouldFlushSession(sessionID: string): boolean {
  const last = lastFlushBySession.get(sessionID)
  if (last !== undefined && Date.now() - last < FLUSH_COOLDOWN_MS) return false
  const cycle = flushCycleBySession.get(sessionID)
  if (cycle !== undefined && lastFlushedCycleBySession.get(sessionID) === cycle) return false
  return true
}

/** Record that a content flush completed for this session (starts the cooldown + cycle mark). */
export function markFlushed(sessionID: string): void {
  lastFlushBySession.set(sessionID, Date.now())
  const cycle = flushCycleBySession.get(sessionID)
  if (cycle !== undefined) lastFlushedCycleBySession.set(sessionID, cycle)
}

/** Test-only: clear the cooldown / cycle maps between cases. */
export function resetFlushGuardForTests(): void {
  lastFlushBySession.clear()
  flushCycleBySession.clear()
  lastFlushedCycleBySession.clear()
}

const lastFlushHashPath = (roots: MemoryRoots, sessionID: string) =>
  path.join(roots.workspaceDir ?? roots.globalDir, "sessions", `.last-flush-${sanitizeSessionId(sessionID)}`)

const loadLastFlushHash = Effect.fn("Memory.loadLastFlushHash")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  sessionID: string,
) {
  const text = yield* readTextSafe(fs, lastFlushHashPath(roots, sessionID))
  return text?.trim() || undefined
})

const storeLastFlushHash = Effect.fn("Memory.storeLastFlushHash")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  sessionID: string,
  hash: string,
) {
  const ok = yield* writeTextAtomic(fs, lastFlushHashPath(roots, sessionID), `${hash}\n`).pipe(
    Effect.catch(() => Effect.succeed(false as const)),
  )
  if (!ok) {
    yield* Effect.logWarning(`memory flush: failed to persist last-flush hash for ${sessionID}`)
  }
  return ok
})

/**
 * Pull the most recent `## Flush` section from a session log for delta prompts.
 * Returns undefined when no `## Flush` marker exists so drain-only metadata logs
 * do not trigger delta mode (full FLUSH_SYSTEM is used instead).
 * Caps at PRIOR_FLUSH_EXCERPT_CAP characters (tail-biased).
 */
export function priorFlushExcerpt(existing: string | undefined): string | undefined {
  if (existing === undefined) return undefined
  const trimmed = existing.trim()
  if (trimmed.length === 0) return undefined

  const marker = "## Flush"
  const idx = trimmed.lastIndexOf(marker)
  if (idx < 0) return undefined
  const excerpt = trimmed.slice(idx)
  if (excerpt.length <= PRIOR_FLUSH_EXCERPT_CAP) return excerpt
  return excerpt.slice(excerpt.length - PRIOR_FLUSH_EXCERPT_CAP)
}

/**
 * Best-effort embeddings for flush cosine near-dup.
 * Returns undefined when no provider, no prior body, or embed fails —
 * callers fall back to hash/Jaccard only.
 */
export const embedFlushDedupVectors = Effect.fn("Memory.embedFlushDedupVectors")(function* (
  candidate: string,
  prior: string | undefined,
  provider?: EmbeddingProvider,
) {
  if (prior === undefined || prior.trim() === "") return undefined
  const priorBody = prior.replace(/^##\s*Flush\s*/i, "").trim()
  if (priorBody.length === 0) return undefined

  const resolved =
    provider ??
    (yield* resolveMemoryEmbeddingProvider().pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catch(() => Effect.succeed(undefined as EmbeddingProvider | undefined)),
    ))
  if (resolved === undefined) return undefined

  const vectors = yield* resolved.embedBatch([candidate, priorBody]).pipe(
    Effect.catch(() => Effect.succeed(undefined as ReadonlyArray<ReadonlyArray<number>> | undefined)),
  )
  if (vectors === undefined || vectors.length < 2) return undefined
  const cand = vectors[0]
  const prev = vectors[1]
  if (cand === undefined || prev === undefined || cand.length === 0 || cand.length !== prev.length) {
    return undefined
  }
  return { candidate: cand, prior: prev } as const
})

/** Summarizes one session with the LLM and appends the result to the dated session log. */
export const flushSession = Effect.fn("Memory.flushSession")(function* (
  session: SessionSchema.Info,
  store: SessionStore.Interface,
  llm: LLMClientShape,
  models: SessionRunnerModel.Interface,
  fs: FSUtil.Interface,
  global: Global.Interface,
  location: Location.Interface,
) {
  const sessionKey = String(session.id)
  if (!shouldFlushSession(sessionKey)) {
    yield* Effect.logInfo(`memory flush skipped: cooldown for session ${sessionKey}`)
    return
  }

  const messages = yield* store.context(session.id).pipe(Effect.catch(() => Effect.succeed([])))
  if (messages.length === 0) return

  const roots = resolveRoots(path.join(global.data, "memory"), location.directory)
  const statsBase = roots.workspaceDir ?? roots.globalDir
  const model = yield* models.resolve(session).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!model) {
    recordFlushFailed("no-model")
    yield* persistFlushStats(fs, statsBase).pipe(Effect.catch(() => Effect.succeed(false)))
    yield* Effect.logWarning(`memory flush skipped: no model for session ${sessionKey}`)
    return
  }
  const existing = yield* readTextSafe(fs, sessionLogPath(roots, sessionKey, new Date()))
  const prior = priorFlushExcerpt(existing)
  const systemText =
    prior === undefined
      ? FLUSH_SYSTEM
      : `${FLUSH_DELTA_SYSTEM}\n\n--- Previous flush content ---\n${prior}`

  const request = LLM.request({
    model,
    system: [SystemPart.make(systemText)],
    messages: toLLMMessages(messages, model),
    tools: [],
  })
  let streamFailed = false
  const text = yield* llm.stream(request).pipe(
    Stream.filter(LLMEvent.is.textDelta),
    Stream.map((event) => event.text),
    Stream.mkString,
    Effect.catch(() => {
      streamFailed = true
      return Effect.succeed("")
    }),
  )
  if (streamFailed) {
    recordFlushFailed("stream")
    yield* persistFlushStats(fs, statsBase).pipe(Effect.catch(() => Effect.succeed(false)))
    yield* Effect.logWarning(`memory flush stream failed for session ${sessionKey}`)
    return
  }
  const cleaned = stripModelWrapper(text)
  if (cleaned.length === 0 || isNoReply(cleaned)) {
    if (isNoReply(cleaned)) {
      recordFlushNoReply()
      yield* persistFlushStats(fs, statsBase).pipe(Effect.catch(() => Effect.succeed(false)))
      yield* Effect.logInfo(`memory flush NO_REPLY for session ${sessionKey}`)
    }
    return
  }
  const threatIds = scanForThreats(cleaned)
  if (threatIds.length > 0) {
    recordFlushFailed("threat")
    yield* persistFlushStats(fs, statsBase).pipe(Effect.catch(() => Effect.succeed(false)))
    yield* Effect.logWarning("memory flush blocked: threat patterns " + threatIds.join(", "))
    return
  }

  // Exact + near-duplicate gate vs prior flush section and durable hash marker.
  // When hybrid embedding is configured, also embed candidate + prior for cosine near-dup.
  const vectors = yield* embedFlushDedupVectors(cleaned, prior)
  if (isFlushDuplicate(cleaned, prior, vectors)) {
    yield* Effect.logInfo(`memory flush skipped: near-duplicate of prior flush for ${sessionKey}`)
    markFlushed(sessionKey)
    return
  }
  const hash = flushContentHash(cleaned)
  const priorHash = yield* loadLastFlushHash(fs, roots, sessionKey)
  if (priorHash !== undefined && priorHash === hash) {
    yield* Effect.logInfo(`memory flush skipped: exact hash match for ${sessionKey}`)
    markFlushed(sessionKey)
    return
  }

  const block = `## Flush\n\n${cleaned}`
  const written = yield* appendSessionLog(fs, roots, sessionKey, new Date(), block)
  if (!written) {
    recordFlushFailed("atomic")
    yield* persistFlushStats(fs, statsBase).pipe(Effect.catch(() => Effect.succeed(false)))
    yield* Effect.logWarning(`memory flush atomic write failed for session ${sessionKey}`)
    return
  }
  const hashStored = yield* storeLastFlushHash(fs, roots, sessionKey, hash)
  // Content append already succeeded — count success. Hash marker is best-effort
  // durability for dedup across restarts (warn only, no double-count as failed).
  if (!hashStored) {
    yield* Effect.logWarning(`memory flush: content written but hash marker failed for ${sessionKey}`)
  }
  recordFlushSuccess()
  markFlushed(sessionKey)
  const base = roots.workspaceDir ?? roots.globalDir
  yield* persistFlushStats(fs, base).pipe(Effect.catch(() => Effect.succeed(false)))
})
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const llm = yield* LLMClient.Service
    const models = yield* SessionRunnerModel.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    return Service.of({
      flush: Effect.fn("Memory.flush")(function* (sessionID) {
        const session = yield* Effect.orElseSucceed(store.get(sessionID), () => undefined)
        if (!session) return
        yield* flushSession(session, store, llm, models, fs, global, location).pipe(Effect.catch(() => Effect.void))
      }),
    })
  }),
)

export const node = makeLocationNode({
  name: "memory-flush",
  layer,
  deps: [llmClient, SessionStore.node, SessionRunnerModel.node, FSUtil.node, Location.node, Global.node],
})
