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
import { SessionRunnerModel } from "../session/runner/model"
import { SessionV2 } from "../session"
import { SessionSchema } from "../session/schema"
import { ProjectV2 } from "../project"
import { AbsolutePath } from "../schema"
import { resolveRoots } from "./storage"
import { readTextSafe, writeTextAtomic, type MemoryRoots } from "./storage"
import { NOISE_FLOOR_CHARS, writeCandidate } from "./candidates"
import { listMergeSources, budgetSources, deleteSources, type MergeSource } from "./sources"
import { appendMergedHashes, contentHash, isAlreadyMerged, loadMergedHashes } from "./merged-hashes"
import type { IndexChunk } from "./reindex"
import { acquireMergeLock, releaseMergeLock, markConsolidated, refreshMergeLock, loadDreamStamps, markDreamPhase } from "./merge-lock"
import {
  DEFAULT_DREAM_POLICY,
  dedupeLightSources,
  filterSourcesForPhase,
  selectDuePhase,
  shouldRecover,
} from "./dream-phases"
import { DREAM_SYSTEM, DREAM_LIGHT_SYSTEM, DREAM_REM_SYSTEM } from "./prompts"
import { PRUNE_SYSTEM, selectPruneCandidates } from "./prune"
import { openConfiguredMemoryIndex } from "./reindex"
import { regenerateSummary } from "./summary"
import { scanForThreats } from "./scan"
import { invalidateRecallCache } from "./recall"
import { hasMarkdownStructure, isNoReply, stripModelWrapper } from "./text-utils"
import { memoryDreamHoursEnvConfig, memoryDreamPolicyEnvConfig } from "./config"
import { curatedHealth } from "./health"
import {
  clearConsolidateBackoff,
  persistConsolidateStatus,
  recordConsolidate,
  recordConsolidateHardFailure,
  recordRecoveryCooldown,
  shouldSkipConsolidateBackoff,
  type ConsolidateStatus,
} from "./observability"

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

export type MergeOutcome =
  | { readonly ok: true; readonly sourcesMerged: number }
  | { readonly ok: false; readonly reason: string }

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
  system: string = DREAM_SYSTEM,
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
  if (pending.length === 0) return { ok: false, reason: "already-merged" } satisfies MergeOutcome

  const { included } = budgetSources(pending, MERGE_INPUT_CAP_CHARS)
  if (included.length === 0) return { ok: false, reason: "budget-empty" } satisfies MergeOutcome

  const input = included.map(formatSourceBlock).join("\n\n---\n\n")
  const boundedPruneList = pruneList.slice(0, 200)
  const pruneSection =
    boundedPruneList.length > 0
      ? `\n\nPRUNE LIST (chunk excerpts to remove if no longer relevant):\n${boundedPruneList
          .map((item) => `- ${item.chunkId} (${item.path}): ${item.excerpt}`)
          .join("\n")}\n`
      : ""
  const systemPrompt = boundedPruneList.length > 0 ? `${system}\n\n${PRUNE_SYSTEM}` : system
  const request = LLM.request({
    model,
    system: [SystemPart.make(systemPrompt)],
    messages: [
      Message.user(
        `EXISTING MEMORY:\n${existing.slice(0, MEMORY_CAP_CHARS)}\n\nSOURCES:\n${input.slice(0, MERGE_INPUT_CAP_CHARS)}${pruneSection}`,
      ),
    ],
    tools: [],
  })
  const raw = (yield* streamText(llm, request)).trim()
  const merged = stripModelWrapper(raw)
  if (merged.length === 0 || isNoReply(merged)) {
    yield* Effect.logInfo("memory consolidate: LLM returned empty or NO_REPLY; sources kept")
    return { ok: false, reason: "no-reply" } satisfies MergeOutcome
  }
  if (!hasMarkdownStructure(merged)) {
    yield* Effect.logWarning("memory consolidate: merge output lacks markdown structure; sources kept")
    return { ok: false, reason: "no-markdown" } satisfies MergeOutcome
  }
  if (merged.length > MEMORY_CAP_CHARS) {
    yield* Effect.logWarning("memory consolidate: merged archive over cap; sources kept")
    return { ok: false, reason: "over-cap" } satisfies MergeOutcome
  }
  if (scanForThreats(merged).length > 0) {
    yield* Effect.logWarning("memory consolidate: threat patterns in LLM output; sources kept")
    return { ok: false, reason: "threat" } satisfies MergeOutcome
  }

  // Snapshot prior archive so a ledger failure can roll back MEMORY.md. Without
  // rollback, the next run re-merges the same sources into an already-updated
  // archive and duplicates content (sources kept + ledger missing hashes).
  const priorArchive = yield* readTextSafe(fs, target)
  const written = yield* writeTextAtomic(fs, target, merged)
  if (!written) {
    yield* Effect.logWarning("memory consolidate: atomic MEMORY.md write failed; sources kept")
    return { ok: false, reason: "atomic" } satisfies MergeOutcome
  }

  const hashes = included.map((source) => contentHash(source.id, source.text))
  const ledgerOk = yield* appendMergedHashes(fs, base, hashes)
  if (!ledgerOk) {
    yield* Effect.logWarning("memory consolidate: hash ledger append failed; rolling back MEMORY.md; sources kept")
    if (priorArchive === undefined) {
      yield* fs.remove(target).pipe(Effect.catch(() => Effect.void))
    } else {
      yield* writeTextAtomic(fs, target, priorArchive).pipe(Effect.catch(() => Effect.succeed(false)))
    }
    return { ok: false, reason: "ledger" } satisfies MergeOutcome
  }
  yield* deleteSources(fs, included)
  return { ok: true, sourcesMerged: included.length } satisfies MergeOutcome
})
const noteOutcome = Effect.fn("Memory.noteConsolidateOutcome")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  status: Exclude<ConsolidateStatus, "never">,
  reason?: string,
  sourcesMerged?: number,
) {
  recordConsolidate({ status, reason, sourcesMerged })
  yield* persistConsolidateStatus(fs, memoryBase(roots), status, reason).pipe(Effect.catch(() => Effect.succeed(false)))
})

/** True when MEMORY.md exists but memory_summary.md is missing or empty. */
const needsSummaryHeal = Effect.fn("Memory.needsSummaryHeal")(function* (fs: FSUtil.Interface, roots: MemoryRoots) {
  const base = memoryBase(roots)
  const archive = yield* readTextSafe(fs, path.join(base, "MEMORY.md"))
  if (archive === undefined || archive.trim() === "") return false
  const summary = yield* readTextSafe(fs, path.join(base, "memory_summary.md"))
  return summary === undefined || summary.trim() === ""
})

/**
 * REM pass: mines cross-session patterns from MEMORY.md plus high-access
 * sources and writes them as a new candidate file. Never rewrites MEMORY.md,
 * never deletes sources, never regenerates the summary.
 */
const remPatternPass = Effect.fn("Memory.remPatternPass")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  llm: LLMClientShape,
  model: Model,
  sources: ReadonlyArray<MergeSource>,
) {
  const archive = (yield* readTextSafe(fs, memoryPath(roots))) ?? ""
  const excerpts = sources
    .slice(0, 200)
    .map((source) => `### ${source.relativePath}\n${source.text.slice(0, 2000)}`)
    .join("\n\n---\n\n")
  const request = LLM.request({
    model,
    system: [SystemPart.make(DREAM_REM_SYSTEM)],
    messages: [
      Message.user(
        `EXISTING MEMORY:\n${archive.slice(0, MEMORY_CAP_CHARS)}\n\nHIGH-ACCESS SOURCES:\n${excerpts.slice(0, MERGE_INPUT_CAP_CHARS)}`,
      ),
    ],
    tools: [],
  })
  const raw = (yield* streamText(llm, request)).trim()
  const patterns = stripModelWrapper(raw)
  if (patterns.length === 0 || isNoReply(patterns) || !hasMarkdownStructure(patterns)) return false
  if (scanForThreats(patterns).length > 0) {
    yield* Effect.logWarning("memory consolidate: REM output contains threat patterns; candidate dropped")
    return false
  }
  const date = new Date().toISOString().slice(0, 10)
  return yield* writeCandidate(fs, roots, `rem-patterns-${date}`, patterns)
})

/** Gated consolidation: lock + phase selection (light/deep/rem/recovery) + noise/threat filtering + merge + summary regen. */
export const runConsolidation = Effect.fn("Memory.runConsolidation")(function* (input: MergeInput) {
  const { fs, roots, llm, model } = input
  const base = memoryBase(roots)
  if (shouldSkipConsolidateBackoff(base)) {
    yield* noteOutcome(fs, roots, "skipped", "backoff")
    return
  }
  const locked = yield* acquireMergeLock(fs, roots)
  if (!locked) {
    yield* noteOutcome(fs, roots, "skipped", "lock-held")
    return
  }
  try {
    const stamps = yield* loadDreamStamps(fs, roots)
    const health = yield* curatedHealth(fs, base)
    const allSources = yield* listMergeSources(fs, roots)
    const dreamPolicy = memoryDreamPolicyEnvConfig()
    // Recovery overrides phase intervals whenever curated memory dropped below
    // the configured health threshold while short-term sources exist to rebuild from.
    const recovering = shouldRecover(health, dreamPolicy.recoveryThreshold, allSources.length)
    const phase = recovering ? ("recovery" as const) : selectDuePhase(Date.now(), stamps, memoryDreamHoursEnvConfig())
    if (phase === undefined) {
      yield* noteOutcome(fs, roots, "skipped", "too-soon")
      return
    }
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
      const contents: Array<MergeSource> = []
      for (const source of allSources) {
        // Noise floor: only auto-delete candidate stubs. User notes and session
        // logs below the floor are kept for a human/future pass (never silent loss).
        if (source.text.trim().length < NOISE_FLOOR_CHARS) {
          if (source.kind === "candidate") yield* deleteSources(fs, [source])
          continue
        }
        if (scanForThreats(source.text).length > 0) {
          // Threat: delete only candidates; quarantine user notes/sessions by skip (keep on disk).
          if (source.kind === "candidate") yield* deleteSources(fs, [source])
          else yield* Effect.logWarning(`memory consolidate: skipping threatened ${source.kind} source ${source.id}`)
          continue
        }
        contents.push(source)
      }
      if (contents.length === 0) {
        // Self-heal: MEMORY exists but summary missing after a prior partial success.
        if (yield* needsSummaryHeal(fs, roots)) {
          const summaryOk = yield* regenerateSummary(fs, roots, llm, model)
          if (summaryOk) {
            clearConsolidateBackoff(base)
            yield* noteOutcome(fs, roots, "completed", "summary-heal")
          } else {
            yield* noteOutcome(fs, roots, "failed", "summary-heal")
          }
          return
        }
        // No sources at all: the phase gate already evaluated, so the phase is
        // done for this cycle — advance the stamp so the next tick does not
        // re-select the same due phase (the no-source state cannot change
        // within the interval). The summary-heal branch above stays un-advanced
        // so a failed heal retries next tick instead of waiting out the phase.
        // Recovery still needs cooldown: health may stay 0 while only noise existed.
        yield* markDreamPhase(fs, roots, phase)
        if (phase === "recovery") recordRecoveryCooldown(base)
        else clearConsolidateBackoff(base)
        yield* noteOutcome(fs, roots, "nothing", "no-sources")
        return
      }
      const index = yield* openConfiguredMemoryIndex(fs, roots).pipe(Effect.catch(() => Effect.succeed(undefined)))
      let pruneList: Array<{ chunkId: string; path: string; excerpt: string }> = []
      let accessByPath: Map<string, number> | undefined
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
          // Access counts come from chunks of the current consolidation's root
          // only: chunk.path is relative to the chunk's owning root, and the
          // sources gated below are current-root files. A cross-root path
          // collision would otherwise let a workspace session pass the deep/rem
          // access gate on a global chunk's count (and vice versa).
          const currentRoot: "global" | "workspace" = roots.workspaceDir !== undefined ? "workspace" : "global"
          accessByPath = new Map(
            chunks
              .filter((chunk) => chunk.root === currentRoot)
              .filter((chunk) => Number.isFinite(chunk.accessCount))
              .map((chunk) => [chunk.path, chunk.accessCount] as const),
          )
        } finally {
          yield* index.close().pipe(Effect.catch(() => Effect.void))
        }
      }
      // Deep/rem gate sessions and candidates on index access counts; sources
      // without index metadata fail open and stay eligible. The minAccess gate
      // comes from OPENCODE_MEMORY_DREAM_DEEP_MIN_ACCESS (default 3).
      const eligible = filterSourcesForPhase(
        contents.map((source) => ({ ...source, accessCount: accessByPath?.get(source.relativePath) })),
        phase,
        { ...DEFAULT_DREAM_POLICY, minAccess: dreamPolicy.minAccess },
      )
      if (eligible.length === 0) {
        // The phase gate already evaluated for this cycle: advance the stamp so
        // the next tick does not re-select the same due phase and re-filter
        // identical sources (mirrors the no-reply fix).
        yield* markDreamPhase(fs, roots, phase)
        // Recovery ignores phase stamps (health-gated). Empty eligible during
        // recovery would otherwise re-fire every 30m — apply hard-failure backoff.
        if (phase === "recovery") recordRecoveryCooldown(base)
        else clearConsolidateBackoff(base)
        yield* noteOutcome(fs, roots, "nothing", "no-sources-for-phase")
        return
      }
      if (phase === "rem") {
        const wrote = yield* remPatternPass(fs, roots, llm, model, eligible)
        yield* markDreamPhase(fs, roots, phase)
        clearConsolidateBackoff(base)
        yield* noteOutcome(fs, roots, wrote ? "completed" : "nothing", wrote ? undefined : "no-patterns")
        return
      }
      // Light/recovery: Jaccard near-dup against archive + earlier sources (0.9).
      let mergeInput = eligible
      if (phase === "light" || phase === "recovery") {
        const archive = (yield* readTextSafe(fs, memoryPath(roots))) ?? ""
        mergeInput = dedupeLightSources(eligible, archive, DEFAULT_DREAM_POLICY.dedupeThreshold)
        if (mergeInput.length === 0) {
          yield* markDreamPhase(fs, roots, phase)
          if (phase === "recovery") recordRecoveryCooldown(base)
          else clearConsolidateBackoff(base)
          yield* noteOutcome(fs, roots, "nothing", "light-deduped")
          return
        }
      }
      const outcome = yield* mergeCandidates(
        fs,
        roots,
        llm,
        model,
        mergeInput,
        pruneList,
        phase === "light" || phase === "recovery" ? DREAM_LIGHT_SYSTEM : DREAM_SYSTEM,
      )
      if (outcome.ok) {
        // Write summary before marking the phase stamp so a crash leaves sources
        // gone only after we at least attempted summary — heal path covers empty summary.
        const summaryOk = yield* regenerateSummary(fs, roots, llm, model)
        yield* markDreamPhase(fs, roots, phase)
        yield* markConsolidated(fs, roots)
        clearConsolidateBackoff(base)
        invalidateRecallCache()
        if (!summaryOk) {
          yield* noteOutcome(fs, roots, "failed", "summary", outcome.sourcesMerged)
        } else {
          yield* noteOutcome(fs, roots, "completed", undefined, outcome.sourcesMerged)
        }
      } else if (outcome.reason === "already-merged" || outcome.reason === "no-reply" || outcome.reason === "budget-empty") {
        // A no-reply pass ran the LLM and found nothing worth persisting: mark
        // the phase done so the next 30-min tick does not burn tokens re-asking
        // with identical input. already-merged/budget-empty never reached the
        // LLM (sources gone or over budget), so they stay free to retry —
        // except recovery, which ignores stamps and would re-burn LLM every tick.
        if (outcome.reason === "no-reply") yield* markDreamPhase(fs, roots, phase)
        if (phase === "recovery") {
          recordRecoveryCooldown(base)
        } else {
          clearConsolidateBackoff(base)
        }
        yield* noteOutcome(fs, roots, "nothing", outcome.reason)
      } else {
        // Hard failures (over-cap, threat, atomic, ledger, no-markdown): backoff to avoid token burn.
        // Recovery failures always cool down (health stays low until next success).
        if (phase === "recovery") {
          recordRecoveryCooldown(base)
        } else if (
          outcome.reason === "over-cap" ||
          outcome.reason === "threat" ||
          outcome.reason === "atomic" ||
          outcome.reason === "ledger" ||
          outcome.reason === "no-markdown"
        ) {
          recordConsolidateHardFailure(base)
        }
        yield* noteOutcome(fs, roots, "failed", outcome.reason)
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
        const llm = yield* Effect.serviceOption(LLMClient.Service)
        if (llm._tag === "None") return
        const roots = resolveRoots(path.join(global.data, "memory"), location.directory)
        const model = yield* models.resolve(syntheticSession).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!model) {
          // Distinguish "never ran / disabled" from "provider unavailable" in health.
          yield* noteOutcome(fs, roots, "failed", "no-model")
          return
        }
        yield* runDualRootConsolidation({
          fs,
          globalDir: path.join(global.data, "memory"),
          projectDirectory: location.directory,
          llm: llm.value,
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
  deps: [SessionRunnerModel.node, FSUtil.node, Global.node, Location.node],
})
