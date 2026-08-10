export * as MemoryFlush from "./flush"

import { Context, Effect, Layer, Stream } from "effect"
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
import { recordFlushFailed, recordFlushNoReply, recordFlushSuccess } from "./observability"
import { isNoReply, stripModelWrapper } from "./text-utils"
import { flushContentHash, isFlushDuplicate } from "./flush-dedup"

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
  yield* writeTextAtomic(fs, lastFlushHashPath(roots, sessionID), `${hash}\n`).pipe(Effect.catch(() => Effect.succeed(false)))
})

/**
 * Pull the most recent `## Flush` section from a session log for delta prompts.
 * Falls back to the whole non-empty log when no section marker is present.
 * Caps at PRIOR_FLUSH_EXCERPT_CAP characters (tail-biased).
 */
export function priorFlushExcerpt(existing: string | undefined): string | undefined {
  if (existing === undefined) return undefined
  const trimmed = existing.trim()
  if (trimmed.length === 0) return undefined

  const marker = "## Flush"
  const idx = trimmed.lastIndexOf(marker)
  const excerpt = idx >= 0 ? trimmed.slice(idx) : trimmed
  if (excerpt.length <= PRIOR_FLUSH_EXCERPT_CAP) return excerpt
  return excerpt.slice(excerpt.length - PRIOR_FLUSH_EXCERPT_CAP)
}

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

  const model = yield* models.resolve(session).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!model) return

  const roots = resolveRoots(path.join(global.data, "memory"), location.directory)
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
  const text = yield* llm.stream(request).pipe(
    Stream.filter(LLMEvent.is.textDelta),
    Stream.map((event) => event.text),
    Stream.mkString,
    Effect.catch(() => Effect.succeed("")),
  )
  const cleaned = stripModelWrapper(text)
  if (cleaned.length === 0 || isNoReply(cleaned)) {
    if (isNoReply(cleaned)) {
      recordFlushNoReply()
      yield* Effect.logInfo(`memory flush NO_REPLY for session ${sessionKey}`)
    }
    return
  }
  const threatIds = scanForThreats(cleaned)
  if (threatIds.length > 0) {
    recordFlushFailed("threat")
    yield* Effect.logWarning("memory flush blocked: threat patterns " + threatIds.join(", "))
    return
  }

  // Exact + near-duplicate gate vs prior flush section and durable hash marker.
  if (isFlushDuplicate(cleaned, prior)) {
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
    yield* Effect.logWarning(`memory flush atomic write failed for session ${sessionKey}`)
    return
  }
  yield* storeLastFlushHash(fs, roots, sessionKey, hash)
  recordFlushSuccess()
  markFlushed(sessionKey)
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
