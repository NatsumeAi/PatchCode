import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  UnknownProviderReason,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { hitRate } from "@opencode-ai/llm/cache-prefix"
import { Cause, DateTime, Duration, Effect, FiberSet, Layer, Option, Schema, Scope, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Catalog } from "../../catalog"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { Permission } from "../../permission"
import { ProviderV2 } from "../../provider"
import { Question } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { MemoryRecall } from "../../memory/recall"
import { MemoryFlush } from "../../memory/flush"
import { MemoryPreCompress } from "../../memory/pre-compress-wire"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { StructuredOutput } from "../../tool/structured-output"
import { frameToolResult } from "./tool-result-framing"
import { RepairToolCall } from "./repair-tool-call"
import { Hooks } from "../../hooks"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { SessionReminders } from "../reminders"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { PromptTape } from "./prompt-tape"
import { PromptTapeStore } from "./prompt-tape-store"
import { PromptSubtask } from "../prompt-subtask"
import * as PromptTapeAppend from "./prompt-tape-append"
import { prewarmIfAllowed } from "./prewarm"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { SessionV1 } from "../../session-legacy"
import { FSUtil } from "../../fs-util"
import { SessionTable } from "../sql"
import { eq } from "drizzle-orm"
import { InstallationVersion } from "../../installation/version"
import { WorkspaceV2 } from "../../workspace"
import { LoopControlHost, type LoopControlHooks } from "./loop-control-host"
import { IterationBudget } from "../loop-control/iteration-budget"
import { TimerDaemon } from "../loop-control/timer-daemon"
import { TerminalController } from "../loop-control/terminal-controller"
import { GoalStore } from "../loop-control/goal-store"
import { VerifierBiDirectional, type NextTurnSystemContext } from "./verifier-bi-directional"
import { ContextEngine } from "./context-engine"
import { Token } from "../../util/token"
import { SessionRuntime, type Instance } from "../runtime"
import { TreeBudget } from "../tree-budget"
import { SubagentLifecycle } from "../subagent-lifecycle"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { PersonaInject } from "../persona/inject"
import { PluginHooks } from "../../plugin-hooks"
import { SessionRetry } from "./retry"
import { OverflowContinue } from "../overflow-continue"
import { GitLabWorkflow } from "../gitlab-workflow"
import { Image } from "../../image"
import { Prompt } from "../prompt"
import { Flag } from "../../flag/flag"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [x] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [x] Persist snapshots and file patches (step start/end + session summary diffs).
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [x] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [x] Update title (first user turn) and session summary diffs after steps.
 *   - [ ] Compaction state and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

/**
 * Compute USD cost for a turn's usage against the model catalog price list.
 * Matches the legacy Session.getUsage shape: input is already non-cached,
 * output excludes reasoning, cache read/write billed separately per 1M tokens;
 * the active tier is the largest context tier the total context exceeds.
 * Reasoning tokens are charged at the output rate (legacy temporary strategy).
 */
const costOf = (
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  model: ModelV2.Info | undefined,
) => {
  if (!model || model.cost === undefined || model.cost.length === 0) return 0
  const contextTokens = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  const tier = model.cost
    .filter((cost) => cost.tier?.type === "context" && contextTokens > cost.tier.size)
    .sort((a, b) => b.tier!.size - a.tier!.size)[0]
  const cost = tier ?? model.cost.at(-1)
  if (!cost) return 0
  return (
    (tokens.input * cost.input) / 1_000_000 +
    (tokens.output * cost.output) / 1_000_000 +
    (tokens.reasoning * cost.output) / 1_000_000 +
    (tokens.cache.read * cost.cache.read) / 1_000_000 +
    (tokens.cache.write * cost.cache.write) / 1_000_000
  )
}

/**
 * Inline local media attachments as data URIs before provider-history lowering.
 * data:/http(s): URIs already carry bytes or a reachable URL; file:// and bare
 * paths are read from disk. Unreadable files keep their original URI so the
 * provider still receives the path (best-effort, matches TODO in to-llm-message).
 */
const mediaMaterializer = (fs: FSUtil.Interface) =>
  Effect.fn("SessionRunner.materializeMedia")(function* (messages: readonly SessionMessage.Message[]) {
    const inline = (uri: string, mime: string): Effect.Effect<{ uri: string; mime: string }, never, FSUtil.Service> => {
      if (uri.startsWith("data:") || uri.startsWith("http:") || uri.startsWith("https:"))
        return Effect.succeed({ uri, mime })
      const path = uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri
      return fs
        .readFile(path)
        .pipe(
          Effect.map((bytes) => ({ uri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`, mime })),
          Effect.catch(() => Effect.succeed({ uri, mime })),
        )
    }

    return yield* Effect.forEach(Array.from(messages), (message): Effect.Effect<SessionMessage.Message, never, FSUtil.Service> => {
      if (message.type === "user") {
        const files = message.files
        if (files === undefined || files.length === 0) return Effect.succeed(message)
        return Effect.gen(function* () {
          const materialized = yield* Effect.forEach(Array.from(files), (file) =>
            inline(file.uri, file.mime).pipe(Effect.map(({ uri, mime }) => ({ ...file, uri, mime }))),
          )
          return { ...message, files: materialized }
        })
      }
      if (message.type === "assistant") {
        const touched = message.content.some(
          (item) => item.type === "tool" && "content" in item.state && item.state.content.some((p) => p.type === "file"),
        )
        if (!touched) return Effect.succeed(message)
        return Effect.gen(function* () {
          const content = yield* Effect.forEach(
            Array.from(message.content),
            (item): Effect.Effect<SessionMessage.AssistantContent, never, FSUtil.Service> => {
              if (item.type !== "tool") return Effect.succeed(item)
              const state = item.state
              if (!("content" in state)) return Effect.succeed(item)
              const files = state.content.filter((part) => part.type === "file")
              if (files.length === 0) return Effect.succeed(item)
              return Effect.gen(function* () {
                const materialized = yield* Effect.forEach(Array.from(files), (file) =>
                  inline(file.uri, file.mime).pipe(Effect.map(({ uri, mime }) => ({ ...file, uri, mime }))),
                )
                const map = new Map(files.map((file, index) => [file.uri, materialized[index]]))
                return {
                  ...item,
                  state: {
                    ...state,
                    content: state.content.map((part) =>
                      part.type === "file" && map.get(part.uri) ? (map.get(part.uri) as typeof part) : part,
                    ),
                  },
                }
              })
            },
          )
          return { ...message, content }
        })
      }
      return Effect.succeed(message)
    })
  })

const TITLE_MAX_LENGTH = 50
const TITLE_TIMEOUT = Duration.seconds(15)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const catalog = yield* Catalog.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const runtime = yield* SessionRuntime.Service
    const fs = yield* FSUtil.Service
    const database = yield* Database.Service
    const db = database.db
    const provideRunnerGlobals = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(Database.Service, database),
        Effect.provideService(EventV2.Service, events),
        Effect.provideService(SessionStore.Service, store),
        Effect.provideService(FSUtil.Service, fs),
      )
    const persistTape = (sessionID: SessionSchema.ID, baselineSeq: number, tape: PromptTape.Tape) =>
      Effect.gen(function* () {
        PromptTapeStore.set(sessionID, baselineSeq, tape)
        yield* SessionContextEpoch.saveTape(db, sessionID, {
          tape,
          lastSeq: PromptTapeStore.getLastSeq(sessionID, baselineSeq),
          messageSeqs: PromptTapeStore.getMessageSeqs(sessionID, baselineSeq),
          recall: PromptTapeStore.getRecall(sessionID, baselineSeq) ?? "",
        })
      })
    const dropTape = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        PromptTapeStore.clear(sessionID)
        yield* SessionContextEpoch.saveTape(db, sessionID, null)
      })
    // Location-lived scope so title generation outlives the drain Effect.scoped.
    const titleScope = yield* Scope.make()
    const compaction = SessionCompaction.make({
      events,
      llm,
      config: yield* config.entries(),
      onPreCompress: (yield* Effect.serviceOption(MemoryPreCompress.Service)).pipe(
        Option.map((service) => service.extract),
        Option.getOrUndefined,
      ),
    })
    const materializeMedia = mediaMaterializer(fs)
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const isDefaultTitle = (title: string) =>
      /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)

    const truncateTitle = (value: string) =>
      value.length > TITLE_MAX_LENGTH ? value.substring(0, TITLE_MAX_LENGTH - 3) + "..." : value

    const loadSessionRow = Effect.fn("SessionRunner.loadSessionRow")(function* (sessionID: SessionSchema.ID) {
      return yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    })

    const publishSessionUpdated = Effect.fn("SessionRunner.publishSessionUpdated")(function* (
      sessionID: SessionSchema.ID,
      patch: {
        title?: string
        summary?: {
          additions?: number
          deletions?: number
          files?: number
          diffs?: Snapshot.LegacyFileDiff[]
        }
      },
    ) {
      const row = yield* loadSessionRow(sessionID)
      if (!row) return
      const now = Date.now()
      const summary = patch.summary
        ? {
            additions: patch.summary.additions ?? row.summary_additions ?? 0,
            deletions: patch.summary.deletions ?? row.summary_deletions ?? 0,
            files: patch.summary.files ?? row.summary_files ?? 0,
            diffs: patch.summary.diffs ?? row.summary_diffs ?? [],
          }
        : row.summary_diffs || row.summary_files
          ? {
              additions: row.summary_additions ?? 0,
              deletions: row.summary_deletions ?? 0,
              files: row.summary_files ?? 0,
              diffs: row.summary_diffs ?? [],
            }
          : undefined
      const info = SessionV1.SessionInfo.make({
        id: row.id,
        slug: row.slug,
        version: row.version || InstallationVersion,
        projectID: row.project_id,
        directory: row.directory,
        path: row.path ?? undefined,
        workspaceID: row.workspace_id ? WorkspaceV2.ID.make(row.workspace_id) : undefined,
        parentID: row.parent_id ?? undefined,
        title: patch.title ?? row.title,
        agent: row.agent ?? undefined,
        model: row.model
          ? {
              id: ModelV2.ID.make(row.model.id),
              providerID: ProviderV2.ID.make(row.model.providerID),
              variant: row.model.variant,
            }
          : undefined,
        cost: row.cost,
        tokens: {
          input: row.tokens_input,
          output: row.tokens_output,
          reasoning: row.tokens_reasoning,
          cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
        },
        summary,
        time: {
          created: row.time_created,
          updated: now,
          compacting: row.time_compacting ?? undefined,
          archived: row.time_archived ?? undefined,
        },
        permission: row.permission ?? undefined,
        metadata: row.metadata ?? undefined,
        share: row.share_url ? { url: row.share_url } : undefined,
        // Brands differ across V1/V2 message IDs; preserve payload for projector.
        revert: row.revert
          ? ({
              messageID: row.revert.messageID,
              partID: row.revert.partID,
              snapshot: row.revert.snapshot,
              diff: row.revert.diff,
            } as unknown as SessionV1.SessionInfo["revert"])
          : undefined,
      })
      yield* events.publish(SessionV1.Event.Updated, { sessionID, info })
    })

    const resolveTitleModel = Effect.fn("SessionRunner.resolveTitleModel")(function* (session: SessionSchema.Info) {
      const providerID = session.model?.providerID
      if (!providerID) return yield* models.resolve(session)
      const titleAgent = yield* agents.get(AgentV2.ID.make("title"))
      if (titleAgent?.model && titleAgent.model.providerID === providerID) {
        return yield* models.resolve({ ...session, model: titleAgent.model }).pipe(
          Effect.catch(() => models.resolve(session)),
        )
      }
      // Stay on the session provider. catalog.default() / a title agent on
      // another provider (zen) 502s isolated tests.
      const small = yield* catalog.model.small(providerID)
      if (!small) return yield* models.resolve(session)
      return yield* models
        .resolve({
          ...session,
          model: ModelV2.Ref.make({ id: small.id, providerID: small.providerID }),
        })
        .pipe(Effect.catch(() => models.resolve(session)))
    })

    const ensureTitle = Effect.fn("SessionRunner.ensureTitle")(function* (sessionID: SessionSchema.ID) {
      const session = yield* getSession(sessionID)
      if (session.parentID) return
      if (!isDefaultTitle(session.title)) return

      const context = yield* store.context(sessionID)
      const users = context.filter((m) => m.type === "user")
      // Rapid-fire may promote multiple users in one drain; still title from the first.
      if (users.length === 0) return
      const firstUser = users[0]
      if (firstUser.type !== "user") return
      const userText = firstUser.text?.trim()
      if (!userText) return

      const titleAgent = yield* agents.get(AgentV2.ID.make("title"))
      const model = yield* resolveTitleModel(session).pipe(Effect.catch(() => Effect.succeed(undefined as undefined)))
      if (!model) return

      const system = titleAgent?.system
        ? [SystemPart.make(titleAgent.system)]
        : [SystemPart.make("Generate a brief thread title. Output ONLY the title on one line.")]
      const request = LLM.request({
        model,
        system,
        messages: [Message.user(`Generate a title for this conversation:\n${userText}`)],
        tools: [],
      })
      const text = yield* llm.stream(request).pipe(
        Stream.filter(LLMEvent.is.textDelta),
        Stream.map((e) => e.text),
        Stream.mkString,
        Effect.catch(() => Effect.succeed("")),
      )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const title = truncateTitle(cleaned)
      yield* publishSessionUpdated(sessionID, { title }).pipe(
        Effect.catchCause((cause) => Effect.logError("failed to generate title", { error: Cause.squash(cause) })),
      )
    })

    const scheduleTitle = (sessionID: SessionSchema.ID) =>
      ensureTitle(sessionID).pipe(Effect.timeout(TITLE_TIMEOUT), Effect.ignore, Effect.forkIn(titleScope))

    const persistStepDiffs = Effect.fn("SessionRunner.persistStepDiffs")(function* (
      sessionID: SessionSchema.ID,
      startSnapshot: Snapshot.ID | undefined,
      endSnapshot: Snapshot.ID | undefined,
      files: readonly string[] | undefined,
    ) {
      if (!startSnapshot || !endSnapshot) return
      const diffs = yield* snapshots
        .diff({ from: startSnapshot, to: endSnapshot })
        .pipe(Effect.catch(() => Effect.succeed([] as const)))
      if (!diffs.length && !files?.length) return
      const legacy: Snapshot.LegacyFileDiff[] = diffs.map((d) => ({
        file: String(d.path),
        patch: d.patch,
        additions: d.additions,
        deletions: d.deletions,
        status: d.status,
      }))
      const additions = legacy.reduce((sum, d) => sum + d.additions, 0)
      const deletions = legacy.reduce((sum, d) => sum + d.deletions, 0)
      yield* publishSessionUpdated(sessionID, {
        summary: {
          additions,
          deletions,
          files: files?.length ?? legacy.length,
          diffs: legacy,
        },
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to persist step diffs", { cause })))
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    // Official continue_loop_on_deny (default false) keeps the drain going after a deny.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof Permission.DeclinedError || reason.defect instanceof Question.RejectedError),
      )
    const continueLoopOnDeny = Effect.fn("SessionRunner.continueLoopOnDeny")(function* () {
      const cfg = yield* config.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[])))
      return cfg.some((entry) => entry.type === "document" && entry.info.experimental?.continue_loop_on_deny === true)
    })

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    // Epoch-only relevance recall: appended as a static source once per context
    // epoch (initialize/prepare), preserving the prefix-cache invariant for
    // recall. Empty when the memory system is absent or yields nothing.
    const loadSystemContextAndRecall = (agent: AgentV2.Selection, _sessionID: SessionSchema.ID) =>
      loadSystemContext(agent)

    /**
     * Per-drain loop-control context. Built once at the start of each `run`
     * drain from the session-keyed `SessionRuntime.Instance` bundle, so two
     * concurrent drains over different session IDs never share mutable
     * loop-control services (terminal, budget, worker state, ...). Passed
     * through `runTurnAttempt` and the compaction/failover helper paths so
     * every per-turn hook call resolves the same session-bound hooks.
     */
    interface DrainContext {
      readonly hooks: LoopControlHooks
      readonly timerDaemon: TimerDaemon.Interface
      readonly budget: IterationBudget.Interface
      readonly terminal: TerminalController.Interface
      readonly verifierBiDirectional: VerifierBiDirectional.Interface
      readonly goalStore: GoalStore.Interface
      readonly contextEngine: ContextEngine.Interface
      readonly treeBudget: TreeBudget.Interface
      readonly instance: Instance
    }

    /**
     * Flush a session's memory when memory is wired (location-scoped service).
     * Mirrors the manual /compact hook in V2Session.compact: automatic
     * compaction must persist the same session memory the manual path does.
     * Guarded + fire-and-forget so a memory failure never breaks the turn.
     */
    const flushMemoryIfWired = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        // One flush generation per compact boundary (shared with manual compact).
        MemoryFlush.beginFlushCycle(String(sessionID))
        yield* Effect.serviceOption(MemoryFlush.Service).pipe(
          Effect.flatMap((option) =>
            option._tag === "Some" ? option.value.flush(sessionID).pipe(Effect.catch(() => Effect.void)) : Effect.void,
          ),
        )
      })

    /**
     * Render one drained verifier-reject feedback slice into a single
     * model-visible system-context text. Returns the empty string when both
     * the reason and the evidence are empty, so the caller can omit the
     * SystemPart entirely and avoid duplicating the static baseline parts.
     * The rendering is intentionally stable and self-describing so a snapshot
     * test can pin its shape without coupling to wiring.
     */
    const renderVerifierFeedback = (next: NextTurnSystemContext): string => {
      if (
        next.verifier_reject_reason.length === 0 &&
        next.verifier_reject_evidence.length === 0 &&
        !(next.timer_reminder && next.timer_reminder.length > 0)
      ) {
        return ""
      }
      const lines: string[] = []
      if (next.verifier_reject_reason.length > 0 || next.verifier_reject_evidence.length > 0) {
        lines.push(`<verifier-feedback reason=${JSON.stringify(next.verifier_reject_reason)}>`)
        if (next.verifier_reject_reason.length > 0) lines.push(`reason: ${next.verifier_reject_reason}`)
        for (const item of next.verifier_reject_evidence) {
          const loc = item.line === undefined ? item.file : `${item.file}:${item.line}`
          lines.push(`evidence: ${loc} — ${item.issue}`)
        }
        lines.push("</verifier-feedback>")
      }
      if (next.timer_reminder && next.timer_reminder.length > 0) {
        lines.push(`<harness-timer-reminder>`)
        lines.push(next.timer_reminder)
        lines.push(`</harness-timer-reminder>`)
      }
      return lines.join("\n")
    }

    /**
     * Build the per-drain loop-control context inside the caller's `Scope`.
     *
     * `runtime.getOrCreate` returns the bundle (idempotent per session ID); the
     * bundle is reset before the drain starts and its timer fibers are forked
     * in the same scope that owns the hooks' finalizers, so when the drain
     * scope closes both the hook subscription and the timer fibers tear down
     * together. The location-captured `LLMClient` is provided to
     * `makeSessionHooks` so the registry never depends on it at construction.
     */
    const buildDrainContext = Effect.fn("SessionRunner.buildDrainContext")(function* (
      sessionID: SessionSchema.ID,
    ) {
      const instance: Instance = yield* runtime.getOrCreate(sessionID)
      yield* runtime.resetForDrain(sessionID)
      // Child sessions use independent iteration cap (hermes parent 90 / child 50).
      const sessionRow = yield* store.get(sessionID)
      if (sessionRow?.parentID) {
        yield* instance.budget.setCap(IterationBudget.defaultChildCap).pipe(Effect.ignore)
      }
      const hooks = yield* LoopControlHost.makeSessionHooks(sessionID, instance).pipe(
        Effect.provideService(LLMClient.Service, llm),
      )
      yield* instance.timerDaemon.start.pipe(Effect.forkScoped)
      // D1: auto-seed goal from first user message when empty (once per drain).
      // Avoid SessionHistory.entriesForRunner here — use lightweight store.context only.
      if (!(yield* instance.goalStore.get).trim()) {
        const msgs = yield* store.context(sessionID).pipe(
          Effect.catch(() => Effect.succeed([] as SessionMessage.Message[])),
        )
        const firstUser = msgs.find(
          (m) => m.type === "user" && typeof m.text === "string" && m.text.trim().length > 0,
        )
        if (firstUser && firstUser.type === "user") {
          yield* instance.goalStore.setIfEmpty(firstUser.text)
        }
      }
      return {
        hooks,
        timerDaemon: instance.timerDaemon,
        budget: instance.budget,
        terminal: instance.terminal,
        verifierBiDirectional: instance.verifierBiDirectional,
        goalStore: instance.goalStore,
        contextEngine: instance.contextEngine,
        treeBudget: instance.treeBudget,
        instance,
      }
    })

    const isSystemUpdateMessage = (message: PromptTape.ChatMessage) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith("<system-update>")

    const isVerifierFeedback = (message: PromptTape.ChatMessage) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith("<verifier-feedback")

    const isRealUser = (message: PromptTape.ChatMessage) =>
      message.role === "user" && !isSystemUpdateMessage(message) && !isVerifierFeedback(message)

    // ContextUpdated can be published after a queued user is already in
    // history. V1 last-message was the user prompt; keep system-updates in
    // front of that user so they do not steal the compiled tail.
    const preferPromptLast = (messages: PromptTape.ChatMessage[]) => {
      const updates = messages.filter(isSystemUpdateMessage)
      const rest = messages.filter((message) => !isSystemUpdateMessage(message))
      return updates.length > 0 && rest.length > 0 ? [...updates, ...rest] : messages
    }

    const keepLastRealUser = (messages: PromptTape.ChatMessage[]) => {
      const last = messages.at(-1)
      if (!last || (!isSystemUpdateMessage(last) && !isVerifierFeedback(last))) return messages
      if (messages.filter(isRealUser).length < 2) return messages
      const lastReal = messages.findLastIndex(isRealUser)
      if (lastReal < 0) return messages
      return [...messages.slice(0, lastReal), last, ...messages.slice(lastReal, -1)]
    }

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      drain: DrainContext,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory) return yield* Effect.interrupt
      // D1: auto-seed goal once at drain start is done in buildDrainContext (step-independent).
      yield* drain.hooks.onTurnStart({
        sessionID: session.id,
        step,
        providerID: session.model?.providerID,
      })
      const abortBlocked =
        drain.hooks.shouldContinue && !(yield* drain.hooks.shouldContinue(session.id))
      if (abortBlocked && (step !== 1 || !promotion)) {
        // /loop abort: do not start a new agent turn. Pending steer/queue still
        // runs (user already submitted). Tool-error flush is handled below.
        const last = (yield* store.context(session.id).pipe(Effect.catch(() => Effect.succeed([] as SessionMessage.Message[])))).at(-1)
        const flushTools =
          last?.type === "assistant" &&
          last.content.some((part) => part.type === "tool" && part.state.status !== "completed")
        if (!flushTools) return { needsContinuation: false, step }
      }
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContextAndRecall(agent, session.id), session.id)
      let needsContinuation = false
      let currentStep = step
      if (promotion) {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      yield* PromptSubtask.spawnPending({ sessionID: session.id }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("PromptSubtask.spawnPending failed", cause).pipe(Effect.as(0)),
        ),
      )
      // After Prompted projection: first user message is visible to ensureTitle.
      yield* scheduleTitle(session.id)
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContextAndRecall(agent, session.id), session.id))
      const model = yield* models.resolve(session)
      const modelInfo = yield* models.resolveInfo(session).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const chatModel = {
        providerID: String(model.provider),
        modelID: String(model.id),
        api: {
          id: String(modelInfo?.id ?? model.id),
          npm: modelInfo?.api?.type === "aisdk" ? modelInfo.api.package : undefined,
        },
      }
      const chatParamsInput = {
        sessionID: String(session.id),
        agent: String(agent.id),
        model: chatModel,
        message: { sessionID: String(session.id) },
      }
      // Drain any verifier rejection feedback captured for this session since
      // the previous turn — DoneDecisionLoop injects reason + evidence into
      // the session-bound VerifierBiDirectional channel after a rejected
      // worker claim. Folding it here into the next request's system context
      // makes the rejection visible to the worker without persisting the
      // feedback as a durable transcript message. The drain is atomic per
      // queue, so a second turn sees empty reason + empty evidence and the
      // feedback SystemPart is omitted entirely (no duplicate baseline part).
      const verifierFeedback = renderVerifierFeedback(
        yield* drain.verifierBiDirectional.getNextTurnSystemContext,
      )
      // Debit the iteration budget only after model selection succeeded so that
      // resolution failures do not waste budget (audit #23). Exhaustion admits
      // one single-use grace turn, then requests terminal budget_exhausted and
      // stops the drain without starting another provider turn.
      const admission = yield* drain.budget.consume(1).pipe(
        Effect.catchTag("LoopControl.IterationBudget.BudgetExhausted", () =>
          Effect.gen(function* () {
            if (yield* drain.budget.useGrace) return "grace" as const
            yield* drain.terminal.request("budget_exhausted")
            return "exhausted" as const
          }),
        ),
      )
      if (admission === "exhausted") return { needsContinuation: false, step: currentStep }
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const hydrateSubset = (subset: typeof entries) =>
        Effect.gen(function* () {
          if (subset.length === 0) {
            return [] as Array<{
              chunk: PromptTape.ChatMessage[]
              seq: number
              message: (typeof entries)[number]["message"]
            }>
          }
          const context = yield* materializeMedia(subset.map((entry) => entry.message)).pipe(
            Effect.provideService(FSUtil.Service, fs),
          )
          const mediaById = new Map(context.map((message) => [message.id, message]))
          return subset.map((entry) => {
            const message = mediaById.get(entry.message.id) ?? entry.message
            return { chunk: PromptTapeAppend.hydrateFromSession([message]), seq: entry.seq, message }
          })
        })
      let tape = PromptTapeStore.get(session.id, system.baselineSeq)
      if (!tape) {
        const restored = yield* SessionContextEpoch.loadTape(db, session.id)
        if (restored && restored.baselineSeq === system.baselineSeq) {
          tape = restored.tape
          PromptTapeStore.set(session.id, system.baselineSeq, tape)
          PromptTapeStore.setLastSeq(session.id, system.baselineSeq, restored.lastSeq)
          PromptTapeStore.setMessageSeqs(session.id, system.baselineSeq, restored.messageSeqs)
          PromptTapeStore.setRecall(session.id, system.baselineSeq, restored.recall)
        }
      }
      const storedSettle = PromptTapeStore.getSettle(session.id, system.baselineSeq)
      const storedRepair = PromptTapeStore.getRepair(session.id, system.baselineSeq)
      let toolMaterialization: ToolRegistry.Materialization | undefined = storedSettle
        ? {
            definitions: [],
            hidden: storedRepair?.hidden ?? [],
            settle: storedSettle,
          }
        : undefined
      if (!tape) {
        const personaSystem = yield* PersonaInject.systemTextForSession(session.id).pipe(
          Effect.catch(() => Effect.succeed(undefined as string | undefined)),
        )
        const materialized = StructuredOutput.wrap(
          yield* tools.materialize({
            ...(agent.info ?? {}),
            modelID: model.id,
            providerID: String(model.provider),
          }),
          PromptTapeStore.getFormat(session.id),
          session.id,
        )
        toolMaterialization = materialized
        PromptTapeStore.setSettle(session.id, system.baselineSeq, materialized.settle)
        PromptTapeStore.setRepair(session.id, system.baselineSeq, {
          advertised: materialized.definitions.map((tool) => tool.name),
          hidden: materialized.hidden,
        })
        const systemTextRaw = [agent.info?.system, system.baseline, personaSystem]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .join("\n")
        const chatHook = yield* Effect.serviceOption(PluginHooks.ChatService)
        const systemText = Option.isSome(chatHook)
          ? (yield* chatHook.value.transformSystem({
              sessionID: String(session.id),
              system: [systemTextRaw],
              model: chatModel,
            })).system.join("\n")
          : systemTextRaw
        const originPrepared = yield* LLMClient.prepare<OpenAIChat.OpenAIChatBody>(
          LLM.request({
            model,
            system: systemText,
            tools: materialized.definitions,
            messages: [],
            ...(Option.isSome(chatHook)
              ? yield* chatHook.value.params(chatParamsInput).pipe(
                  Effect.map((hooked) => ({
                    generation: {
                      temperature: hooked.temperature,
                      topP: hooked.topP,
                      topK: hooked.topK,
                      maxTokens: hooked.maxOutputTokens,
                    },
                    providerOptions: hooked.options,
                    http: Object.keys(hooked.headers).length ? { headers: hooked.headers } : undefined,
                  })),
                )
              : {}),
          }),
        )
        const toolName = (tool: { function?: { name?: string }; name?: string }) =>
          tool.function?.name ?? tool.name ?? ""
        const chatTools = originPrepared.body.tools
          ? [...originPrepared.body.tools].sort((a, b) => toolName(a).localeCompare(toolName(b)))
          : undefined
        tape = PromptTape.origin({ system: systemText, tools: chatTools })
        const seqs: number[] = []
        const extras: PromptTape.ChatMessage[] = []
        for (const hydrated of yield* hydrateSubset(entries)) {
          extras.push(...hydrated.chunk)
          for (const _ of hydrated.chunk) seqs.push(hydrated.seq)
        }
        if (extras.length > 0) tape = PromptTape.append(tape, preferPromptLast(extras))
        const maxSeq = entries.reduce((seq, entry) => Math.max(seq, entry.seq), 0)
        PromptTapeStore.setLastSeq(session.id, system.baselineSeq, maxSeq)
        PromptTapeStore.setMessageSeqs(session.id, system.baselineSeq, seqs)
        yield* persistTape(session.id, system.baselineSeq, tape)
        yield* prewarmIfAllowed(llm, model, tape).pipe(Effect.forkIn(titleScope), Effect.asVoid)
      } else {
        if (!toolMaterialization) {
          const materialized = StructuredOutput.wrap(
            yield* tools.materialize({
              ...(agent.info ?? {}),
              modelID: model.id,
              providerID: String(model.provider),
            }),
            PromptTapeStore.getFormat(session.id),
            session.id,
          )
          toolMaterialization = materialized
          PromptTapeStore.setSettle(session.id, system.baselineSeq, materialized.settle)
          PromptTapeStore.setRepair(session.id, system.baselineSeq, {
            advertised: materialized.definitions.map((tool) => tool.name),
            hidden: materialized.hidden,
          })
        }
        const lastSeq = PromptTapeStore.getLastSeq(session.id, system.baselineSeq)
        const extras: PromptTape.ChatMessage[] = []
        const addedSeqs: number[] = []
        let cursor = lastSeq
        const knownSeqs = new Set(PromptTapeStore.getMessageSeqs(session.id, system.baselineSeq))
        // Hydrate holes, not only seq > lastSeq: a user admitted while the
        // previous stream was in flight can have seq between Step.Started and
        // Step.Ended, and lastSeq is often advanced to latestSequence.
        for (const hydrated of yield* hydrateSubset(entries.filter((entry) => !knownSeqs.has(entry.seq)))) {
          if (hydrated.message.type === "assistant") {
            const incoming = hydrated.chunk[0]
            const already = [...tape.messages, ...extras].some(
              (message) =>
                message.role === "assistant" &&
                incoming?.role === "assistant" &&
                JSON.stringify(message.tool_calls) === JSON.stringify(incoming.tool_calls) &&
                message.content === incoming.content,
            )
            if (already) {
              cursor = hydrated.seq
              addedSeqs.push(hydrated.seq)
              continue
            }
          }
          extras.push(...hydrated.chunk)
          for (const _ of hydrated.chunk) addedSeqs.push(hydrated.seq)
          cursor = hydrated.seq
        }
        if (addedSeqs.length > 0) {
          PromptTapeStore.appendMessageSeqs(session.id, system.baselineSeq, addedSeqs)
        }
        if (extras.length > 0) {
          tape = PromptTape.append(tape, preferPromptLast(extras))
        }
        PromptTapeStore.setLastSeq(session.id, system.baselineSeq, cursor)
        yield* persistTape(session.id, system.baselineSeq, tape)
      }
      const recallOption = yield* Effect.serviceOption(MemoryRecall.Service)
      const recall = Option.isSome(recallOption)
        ? yield* recallOption.value.recall(session.id).pipe(Effect.catch(() => Effect.succeed("")))
        : ""
      const previousRecall = PromptTapeStore.getRecall(session.id, system.baselineSeq)
      if (recall !== previousRecall) {
        const extra =
          recall.length > 0
            ? PromptTapeAppend.lowerUser({ text: recall })
            : previousRecall !== undefined && previousRecall.length > 0
              ? PromptTapeAppend.lowerUser({ text: "(memory recall cleared)" })
              : undefined
        PromptTapeStore.setRecall(session.id, system.baselineSeq, recall)
        if (extra) {
          tape = PromptTape.append(tape, [extra])
          PromptTapeStore.appendMessageSeqs(session.id, system.baselineSeq, [
            PromptTapeStore.getLastSeq(session.id, system.baselineSeq),
          ])
          yield* persistTape(session.id, system.baselineSeq, tape)
        }
      }
      const reminder = yield* SessionReminders.text(session.id).pipe(Effect.catch(() => Effect.succeed("")))
      const previousReminder = SessionReminders.get(String(session.id)) ?? ""
      if (reminder !== previousReminder) {
        SessionReminders.set(String(session.id), reminder)
        if (reminder.length > 0) {
          tape = PromptTape.append(tape, [PromptTapeAppend.lowerUser({ text: reminder })])
          PromptTapeStore.appendMessageSeqs(session.id, system.baselineSeq, [
            PromptTapeStore.getLastSeq(session.id, system.baselineSeq),
          ])
          yield* persistTape(session.id, system.baselineSeq, tape)
        }
      }
      const ephemeral: PromptTape.ChatMessage[] = []
      if (verifierFeedback.length > 0) ephemeral.push({ role: "user", content: verifierFeedback })
      if (isLastStep) ephemeral.push({ role: "assistant", content: MAX_STEPS_PROMPT })
      const compiled = PromptTape.compiled(tape, ephemeral)
      const compiledSystem = compiled.messages[0]
      const chatHook = yield* Effect.serviceOption(PluginHooks.ChatService)
      const hooked = Option.isSome(chatHook)
        ? yield* chatHook.value.params(chatParamsInput)
        : undefined
      const npm = modelInfo?.api?.type === "aisdk" ? modelInfo.api.package : undefined
      const providerID = String(model.provider)
      const isOpenaiOauth =
        providerID === "openai" &&
        (modelInfo?.request?.body as { authType?: string } | undefined)?.authType === "oauth"
      const officialOptions: Record<string, unknown> = { ...(hooked?.options ?? {}) }
      if (
        npm === "@ai-sdk/azure" &&
        (officialOptions.useCompletionUrls ||
          (modelInfo?.request?.body as { useCompletionUrls?: boolean } | undefined)?.useCompletionUrls)
      ) {
        delete officialOptions.reasoningSummary
        delete officialOptions.include
      }
      if (isOpenaiOauth && tape.system) officialOptions.instructions = tape.system
      const officialHeaders: Record<string, string> = providerID.startsWith("opencode")
        ? {
            ...(session.projectID ? { "x-opencode-project": String(session.projectID) } : {}),
            "x-opencode-session": String(session.id),
            "x-opencode-request": String(session.id),
            "x-opencode-client": Flag.OPENCODE_CLIENT,
            "User-Agent": `opencode/${InstallationVersion}`,
            ...(hooked?.headers ?? {}),
          }
        : {
            "x-session-affinity": String(session.id),
            "X-Session-Id": String(session.id),
            ...(session.parentID ? { "x-parent-session-id": String(session.parentID) } : {}),
            "User-Agent": `opencode/${InstallationVersion}`,
            ...(hooked?.headers ?? {}),
          }
      const compiledTools = [...(compiled.tools ?? [])]
      const hasHistoryToolCalls = compiled.messages.some((message) => {
        if (!message || typeof message !== "object") return false
        const calls = (message as { tool_calls?: unknown }).tool_calls
        return Array.isArray(calls) && calls.length > 0
      })
      if (providerID.includes("github-copilot") && compiledTools.length === 0 && hasHistoryToolCalls) {
        compiledTools.push({
          type: "function",
          function: {
            name: "_noop",
            description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
            parameters: { type: "object", properties: { reason: { type: "string" } } },
          },
        } as (typeof compiledTools)[number])
      }
      const request = LLM.request({
        model,
        providerOptions: {
          openai: { promptCacheKey, ...(npm === "@ai-sdk/openai" || npm === "@ai-sdk/azure" ? { strict: false } : {}) },
          ...(npm === "@ai-sdk/amazon-bedrock/mantle" ? { bedrock: { strict: false } } : {}),
          ...officialOptions,
        },
        system: tape.system,
        messages: [],
        tools: [],
        toolChoice: isLastStep ? "none" : undefined,
        generation: hooked
          ? {
              temperature: hooked.temperature,
              topP: hooked.topP,
              topK: hooked.topK,
              maxTokens: hooked.maxOutputTokens,
            }
          : undefined,
        http: { headers: officialHeaders },
        compiled: {
          ...compiled,
          tools: compiledTools.length > 0 ? compiledTools : compiled.tools,
          messages: compiledSystem
            ? [compiledSystem, ...keepLastRealUser(compiled.messages.slice(1))]
            : compiled.messages,
        },
      })
      // Token compact path + ContextEngine token-window proactive path.
      // When the engine wants a proactive compact, still use compactIfNeeded as the
      // sole real compact executor so overflow recovery semantics stay single-path.
      const contextWindow = model.route.defaults.limits?.context ?? 0
      yield* drain.contextEngine.setUsage({
        tokens: Token.estimate(
          JSON.stringify({
            system: request.system,
            messages: request.compiled?.messages ?? request.messages,
            tools: request.compiled?.tools ?? request.tools,
          }),
        ),
        window: contextWindow,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request })) {
        yield* dropTape(session.id)
        yield* flushMemoryIfWired(session.id)
        yield* drain.contextEngine.compact.pipe(Effect.ignore)
        return yield* Effect.die(continueAfterCompaction(currentStep))
      }
      if (yield* drain.contextEngine.shouldProactiveCompact) {
        const did = yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request })
        yield* drain.contextEngine.compact.pipe(Effect.ignore)
        if (did) {
          yield* dropTape(session.id)
          yield* flushMemoryIfWired(session.id)
          return yield* Effect.die(continueAfterCompaction(currentStep))
        }
      }
      const startSnapshot = yield* snapshots.capture()
      // Bounded drain-internal retries for transient provider failures (W1).
      // One-shot TurnRetryState limits same-reason recoveries; this caps total
      // stream attempts (1 initial + 2 retries). Budget was already debited above.
      const MAX_STREAM_ATTEMPTS = 3
      const STREAM_IDLE_TIMEOUT = Duration.seconds(120)

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let streamAttempt = 0
          // Loop: each attempt uses a fresh publisher so a failed stream does not
          // leave failAssistant residue before a recoverable retry.
          while (true) {
            streamAttempt++
            needsContinuation = false
            // Fresh fiber set per stream attempt so a failed attempt cannot leave
            // dangling tool fibers that block the next try or scope exit.
            const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
            const publisher = createLLMEventPublisher(events, {
              sessionID: session.id,
              agent: agent.id,
              model: {
                id: ModelV2.ID.make(model.id),
                providerID: ProviderV2.ID.make(model.provider),
                ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
              },
              snapshot: startSnapshot,
            })
            const withPublication = Semaphore.makeUnsafe(1).withPermit
            const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
              withPublication(publisher.publish(event, outputPaths))
            // Open the assistant on the first token/tool (publisher.startAssistant).
            // Opening before the stream left an empty assistant row when the
            // provider returned no events (tool-follow-up with an empty body).
            let overflowFailure: ProviderErrorEvent | undefined
            // Abort hung provider pulls: no chunk for STREAM_IDLE_TIMEOUT ends the turn so
            // child drains settle instead of sitting forever in execution.active.
            const argumentText = new Map<string, string>()
            const toolNames = new Map<string, string>()
            const toolOrder: string[] = []
            const hostedTools = new Set<string>()
            const toolResults = new Map<string, string>()
            const toolSettlements = new Map<string, ToolRegistry.Settlement>()
            let assistantText = ""
            let reasoningText = ""
            if (String(model.provider).includes("gitlab")) {
              const permissionOpt = yield* Effect.serviceOption(Permission.Service)
              GitLabWorkflow.install({
                sessionID: String(session.id),
                systemPrompt: tape.system,
                sessionPreapprovedTools: (toolMaterialization?.definitions ?? []).map((tool) => tool.name),
                runPromise: (effect) => Effect.runPromise(effect as Effect.Effect<unknown>),
                toolExecutor: (toolName, argsJson, requestID) =>
                  Effect.gen(function* () {
                    if (!toolMaterialization) return { result: "", error: `Unknown tool: ${toolName}` }
                    const settled = yield* toolMaterialization
                      .settle({
                        sessionID: session.id,
                        agent: agent.id,
                        assistantMessageID: SessionMessage.ID.create(),
                        call: {
                          type: "tool-call",
                          id: requestID,
                          name: toolName,
                          input: JSON.parse(argsJson),
                        } as never,
                      })
                      .pipe(Effect.catch(() => Effect.succeed(undefined)))
                    if (!settled) return { result: "", error: `Unknown tool: ${toolName}` }
                    const output =
                      typeof settled.result === "object" && settled.result && "value" in settled.result
                        ? String((settled.result as { value?: unknown }).value ?? "")
                        : JSON.stringify(settled.output ?? settled.result)
                    return { result: output }
                  }),
                approvalHandler: (approvalTools) =>
                  Effect.gen(function* () {
                    if (Option.isNone(permissionOpt)) return { approved: false }
                    const unique = [...new Set(approvalTools.map((item) => item.name))]
                    yield* permissionOpt.value.assert({
                      sessionID: session.id,
                      action: "workflow_tool_approval",
                      resources: unique,
                      save: unique,
                      metadata: { tools: approvalTools },
                    })
                    return { approved: true }
                  }).pipe(Effect.catch(() => Effect.succeed({ approved: false }))),
              })
            }
            const providerStream = llm.stream(request).pipe(
              Stream.timeoutOrElse({
                duration: STREAM_IDLE_TIMEOUT,
                orElse: () =>
                  Stream.fail(
                    new LLMError({
                      module: "SessionRunner",
                      method: "stream",
                      reason: new UnknownProviderReason({
                        message: "LLM stream idle timeout (no chunk for 120s)",
                      }),
                    }),
                  ),
              }),
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (overflowFailure || publisher.hasProviderError()) return
                  if (LLMEvent.is.providerError(event)) {
                    if (isContextOverflowFailure(event) && !publisher.hasAssistantOutput()) {
                      overflowFailure = event
                      return
                    }
                  }
                  if (LLMEvent.is.toolInputStart(event)) {
                    toolNames.set(event.id, event.name)
                    if (!argumentText.has(event.id)) argumentText.set(event.id, "")
                    if (!toolOrder.includes(event.id)) toolOrder.push(event.id)
                  }
                  if (LLMEvent.is.toolInputDelta(event)) {
                    argumentText.set(event.id, (argumentText.get(event.id) ?? "") + event.text)
                    toolNames.set(event.id, event.name)
                  }
                  if (LLMEvent.is.textDelta(event)) assistantText += event.text
                  if (event.type === "text-end") {
                    const textHook = yield* Effect.serviceOption(PluginHooks.TextCompleteService)
                    if (Option.isSome(textHook)) {
                      const partID = "id" in event && typeof event.id === "string" ? event.id : "text"
                      const next = yield* textHook.value.complete({
                        sessionID: String(session.id),
                        messageID: String(session.id),
                        partID,
                        text: assistantText,
                      })
                      if (next.text !== assistantText) {
                        yield* publisher.rewriteText(partID, next.text)
                        assistantText = next.text
                      }
                    }
                  }
                  if (LLMEvent.is.reasoningDelta(event)) reasoningText += event.text
                  if (LLMEvent.is.toolCall(event) && !event.providerExecuted) {
                    const stored = PromptTapeStore.getRepair(session.id, system.baselineSeq)
                    const advertised = new Set(
                      toolMaterialization.definitions.length > 0
                        ? toolMaterialization.definitions.map((tool) => tool.name)
                        : (stored?.advertised ?? []),
                    )
                    const hidden = new Set(
                      toolMaterialization.hidden.length > 0 ? toolMaterialization.hidden : (stored?.hidden ?? []),
                    )
                    event = RepairToolCall.repair(event, advertised, hidden)
                  }
                  if (LLMEvent.is.toolCall(event)) {
                    toolNames.set(event.id, event.name)
                    if (!toolOrder.includes(event.id)) toolOrder.push(event.id)
                    if (!argumentText.has(event.id)) {
                      argumentText.set(event.id, JSON.stringify(event.input ?? {}))
                    }
                    if (event.providerExecuted) hostedTools.add(event.id)
                  }
                  if (LLMEvent.is.toolResult(event)) {
                    toolResults.set(event.id, JSON.stringify(event.output ?? event.result))
                    if (event.providerExecuted) hostedTools.add(event.id)
                  }
                  if (LLMEvent.is.toolError(event)) {
                    toolResults.set(event.id, event.message)
                  }
                  yield* publish(event)
                  yield* drain.hooks.onStream({ _tag: "chunk", sessionID: session.id })
                  if (event.type !== "tool-call" || event.providerExecuted) return
                  if (isLastStep) {
                    yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
                    return
                  }
                  yield* drain.hooks.onToolCall({
                    name: event.name,
                    callID: event.id,
                    sessionID: session.id,
                    input: "input" in event ? (event as { input?: unknown }).input : undefined,
                  })
                  needsContinuation = true
                  const assistantMessageID = yield* publisher.assistantMessageID(event.id)
                  yield* Effect.uninterruptibleMask((restore) =>
                    Effect.gen(function* () {
                      // restore(settle) so bash collect / task host Effect.never can
                      // stop. bound() and the settlement value live outside that
                      // restore so a sticky cancel cannot drop Success.
                      let settlement: ToolRegistry.Settlement | undefined
                      const exit = yield* restore(
                        toolMaterialization.settle({
                          sessionID: session.id,
                          agent: agent.id,
                          assistantMessageID,
                          call: event,
                        }),
                      ).pipe(
                        Effect.exit,
                        Effect.tap((ex) =>
                          Effect.sync(() => {
                            if (ex._tag === "Success") settlement = ex.value
                          }),
                        ),
                      )
                      const done = settlement ?? (exit._tag === "Success" ? exit.value : undefined)
                      if (!done) {
                        if (exit._tag === "Failure") return yield* Effect.failCause(exit.cause)
                        return
                      }
                      const imageOpt = yield* Effect.serviceOption(Image.Service)
                      let settledOut = done
                      if (Option.isSome(imageOpt) && done.output?.content.some((part) => part.type === "file" && part.mime.startsWith("image/"))) {
                        const normalized = yield* Effect.forEach(done.output.content, (part) => {
                          if (part.type !== "file" || !part.mime.startsWith("image/") || !part.uri.startsWith("data:"))
                            return Effect.succeed(part)
                          const comma = part.uri.indexOf(",")
                          const payload = comma >= 0 ? part.uri.slice(comma + 1) : ""
                          return imageOpt.value
                            .normalize(part.uri, {
                              uri: part.uri,
                              encoding: "base64",
                              mime: part.mime,
                              content: payload,
                            })
                            .pipe(
                              Effect.map((content) => ({
                                ...part,
                                uri: `data:${content.mime};base64,${content.content}`,
                              })),
                              Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(part)),
                              Effect.catch(() => Effect.succeed(part)),
                            )
                        })
                        settledOut = { ...done, output: { ...done.output, content: normalized } }
                      }
                      toolSettlements.set(event.id, settledOut)
                      toolResults.set(event.id, JSON.stringify(settledOut.output ?? settledOut.result))
                      yield* publish(
                        LLMEvent.toolResult({
                          id: event.id,
                          name: event.name,
                          result: settledOut.result,
                          output: settledOut.output,
                        }),
                        settledOut.outputPaths ?? [],
                      )
                    }),
                  ).pipe(FiberSet.run(toolFibers))
                }),
              ),
              Effect.ensuring(withPublication(publisher.flush())),
            )

            const stream = yield* restore(providerStream).pipe(Effect.exit)
            if (String(model.provider).includes("gitlab")) GitLabWorkflow.uninstall(String(session.id))
            const failure =
              stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
            if (
              recoverOverflow &&
              !publisher.hasAssistantOutput() &&
              isContextOverflowFailure(overflowFailure ?? failure) &&
              (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
            ) {
              // Context-overflow recovery via compaction succeeded; do not route
              // through onFailover (a non-retryable classification would wrongly
              // request terminal failure when the turn legitimately replays).
              yield* flushMemoryIfWired(session.id)
              yield* dropTape(session.id)
              const compactionHook = yield* Effect.serviceOption(PluginHooks.CompactionService)
              const auto =
                Option.isNone(compactionHook) ||
                (yield* compactionHook.value.autocontinue({
                  sessionID: String(session.id),
                  agent: String(agent.id),
                  overflow: true,
                })).enabled
              const lastUser = entries.findLast((entry) => entry.message.type === "user")?.message
              const replayable =
                lastUser && lastUser.type === "user" && OverflowContinue.hasReplayableMedia(lastUser.files)
              const overflowText =
                replayable && lastUser.type === "user"
                  ? OverflowContinue.replayUserText({ text: lastUser.text, files: lastUser.files })
                  : auto
                    ? OverflowContinue.continueText(true)
                    : undefined
              if (overflowText) {
                yield* events
                  .publish(SessionEvent.Synthetic, {
                    sessionID: session.id,
                    timestamp: yield* DateTime.now,
                    messageID: SessionMessage.ID.create(),
                    text: overflowText,
                  })
                  .pipe(Effect.ignore)
              }
              return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
            }
            // V1 processor: overflow with auto-compact disabled (or compact
            // declined) writes ContextOverflowError onto the assistant and
            // returns — it does not fail the drain.
            if (isContextOverflowFailure(overflowFailure ?? failure)) {
              const message = !recoverOverflow
                ? "Context still overflows after compaction. Try a smaller request, a larger-context model, or run /compact manually."
                : (overflowFailure?.message ??
                  (failure instanceof LLMError ? failure.reason.message : "Context overflow"))
              yield* withPublication(publisher.failAssistant(message))
              return { needsContinuation: false, step: currentStep }
            }
            if (overflowFailure) yield* publish(overflowFailure)

            // Transient retry: only before assistant content or provider tool errors.
            if (stream._tag === "Failure") {
              // User/runtime interrupt: durable-close partials (W1 must not skip this).
              if (Cause.hasInterrupts(stream.cause)) {
                // Interrupt in-flight tools (bash inner restore stops the process)
                // then wait for uninterruptible Success + bound() before failing
                // the assistant, so cancel snapshots completed truncated output.
                yield* FiberSet.clear(toolFibers)
                for (const [id, settlement] of toolSettlements) {
                  const name = toolNames.get(id)
                  if (!name) continue
                  yield* publish(
                    LLMEvent.toolResult({
                      id,
                      name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ).pipe(Effect.catchCause(() => Effect.void))
                }
                yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
                yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
                return yield* Effect.failCause(stream.cause)
              }
              const err = failure instanceof LLMError ? failure : undefined
              const canClassify =
                err !== undefined && !publisher.hasProviderError() && !publisher.hasAssistantOutput()
              if (canClassify && streamAttempt < MAX_STREAM_ATTEMPTS) {
                const failover = yield* drain.hooks.onFailover(err)
                if (failover.recovered) {
                  if (drain.hooks.shouldContinue && !(yield* drain.hooks.shouldContinue(session.id))) {
                    yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
                    yield* withPublication(publisher.failAssistant(err.reason.message))
                    return yield* Effect.failCause(stream.cause)
                  }
                  // Official leftover delay: Retry-After (ms/seconds/HTTP-date) or exponential backoff.
                  const hinted = SessionRetry.retryAfterMsFrom(err)
                  const backoffMs =
                    hinted !== undefined && Number.isFinite(hinted)
                      ? Math.min(Math.max(0, hinted), 30_000)
                      : SessionRetry.delay(streamAttempt)
                  const retryHint = SessionRetry.retryable(
                    { data: { message: err.reason.message, isRetryable: true, responseBody: err.reason.message } },
                    String(model.provider),
                  )
                  yield* events
                    .publish(SessionStatusEvent.Status, {
                      sessionID: session.id,
                      status: {
                        type: "retry",
                        attempt: streamAttempt,
                        message: retryHint?.message ?? err.reason.message,
                        ...(retryHint?.action ? { action: retryHint.action } : {}),
                        next: Date.now() + backoffMs,
                      },
                    })
                    .pipe(Effect.catchCause(() => Effect.void))
                  yield* restore(
                    Effect.callback<void>((resume) => {
                      const handle = setTimeout(() => resume(Effect.void), backoffMs)
                      return Effect.sync(() => clearTimeout(handle))
                    }),
                  )
                  if (drain.hooks.shouldContinue && !(yield* drain.hooks.shouldContinue(session.id))) {
                    yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
                    yield* withPublication(publisher.failAssistant(err.reason.message))
                    return yield* Effect.failCause(stream.cause)
                  }
                  continue
                }
                // Not recovered: terminal already requested by onFailover when !recovered.
              } else if (canClassify) {
                // Attempts exhausted — classify once more for terminal side effects.
                yield* drain.hooks.onFailover(err)
              }
              // Exhausted or non-retryable: durable fail + propagate (no tool fiber wait —
              // a clean pre-assistant failure has no tool work to settle).
              if (err && !publisher.hasProviderError()) {
                const retryHint = SessionRetry.retryable(
                  { data: { message: err.reason.message, isRetryable: true, responseBody: err.reason.message } },
                  String(model.provider),
                )
                if (retryHint?.action) {
                  yield* events
                    .publish(SessionStatusEvent.Status, {
                      sessionID: session.id,
                      status: {
                        type: "retry",
                        attempt: streamAttempt,
                        message: retryHint.message,
                        action: retryHint.action,
                        next: Date.now(),
                      },
                    })
                    .pipe(Effect.catchCause(() => Effect.void))
                }
                yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
                yield* withPublication(publisher.failAssistant(retryHint?.message ?? err.reason.message))
              }
              return yield* Effect.failCause(stream.cause)
            }

            // Stream success path (original post-stream settlement).
            const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
            if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
              if (yield* continueLoopOnDeny()) {
                yield* FiberSet.clear(toolFibers)
                yield* withPublication(publisher.failUnsettledTools("Tool execution declined"))
              } else {
                yield* FiberSet.clear(toolFibers)
                yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
                return yield* Effect.interrupt
              }
            }
            if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause)) {
              yield* FiberSet.clear(toolFibers)
              for (const [id, settlement] of toolSettlements) {
                const name = toolNames.get(id)
                if (!name) continue
                yield* publish(
                  LLMEvent.toolResult({
                    id,
                    name,
                    result: settlement.result,
                    output: settlement.output,
                  }),
                  settlement.outputPaths ?? [],
                ).pipe(Effect.catchCause(() => Effect.void))
              }
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
            }
            if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
              const toolFailure = Cause.squash(settled.cause)
              const message = toolFailure instanceof Error ? toolFailure.message : String(toolFailure)
              yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
            }
            const stepSettlement = publisher.stepSettlement()
            let pendingTape: PromptTape.Tape | undefined
            let pendingAdded = 0
            if (
              stream._tag === "Success" &&
              settled._tag === "Success" &&
              !publisher.hasProviderError()
            ) {
              const current = PromptTapeStore.get(session.id, system.baselineSeq)
              if (current) {
                const calls = isLastStep
                  ? []
                  : toolOrder.map((id) => ({
                      id,
                      name: toolNames.get(id) ?? "",
                      arguments: argumentText.get(id) ?? "{}",
                    }))
                const tail: PromptTape.ChatMessage[] = [
                  PromptTapeAppend.lowerAssistantFromStream({
                    text: calls.length > 0 ? assistantText.length > 0 ? assistantText : null : assistantText,
                    toolCalls: calls,
                    reasoning: reasoningText.length > 0 ? reasoningText : undefined,
                  }),
                ]
                for (const call of calls) {
                  if (hostedTools.has(call.id)) continue
                  const content = toolResults.get(call.id)
                  if (content === undefined) continue
                  const framed = frameToolResult(call.name, content)
                  tail.push(
                    PromptTapeAppend.lowerToolResult({
                      toolCallId: call.id,
                      content: typeof framed === "string" ? framed : JSON.stringify(framed),
                    }),
                  )
                }
                pendingTape = PromptTape.append(current, tail)
                pendingAdded = tail.length
              }
            }
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            // Verifier audit only runs on a genuinely successful stream; a failed
            // provider stream must not audit a partial or empty claim. Skip when
            // a later user (or pending steer/queue) is still unanswered — V1
            // runLoop kept going, and the sidecar must not consume the next
            // worker mock / approve-stop before that user is answered.
            if (stream._tag === "Success" && !publisher.hasProviderError() && settled._tag === "Success") {
              const pendingSteer = yield* SessionInput.hasPending(db, session.id, "steer")
              const pendingQueue = yield* SessionInput.hasPending(db, session.id, "queue")
              const history = yield* store.context(session.id).pipe(
                Effect.catch(() => Effect.succeed([] as SessionMessage.Message[])),
              )
              const lastUserIdx = history.findLastIndex((message) => message.type === "user")
              const lastAssistantIdx = history.findLastIndex((message) => message.type === "assistant")
              if (!pendingSteer && !pendingQueue && lastUserIdx <= lastAssistantIdx) {
                yield* drain.hooks.onStreamComplete({
                  sessionID: session.id,
                  finishReason: stepSettlement?.finish ?? "stop",
                  workerClaim: publisher.assistantText(),
                  workerDiffPath: files?.join("\n") ?? "",
                  model,
                })
              }
            }
            // onStreamComplete may request a terminal state (verifier approval,
            // verifier failure, hard abort). When it does, no further provider
            // continuation should be offered even if the stream produced tool calls.
            // Still publish Step.Ended first: V1 processor wrote finish onto the
            // assistant before runLoop decided to break.
            if (drain.hooks.shouldContinue && !(yield* drain.hooks.shouldContinue(session.id))) {
              needsContinuation = false
            }
            if (stepSettlement && !publisher.hasProviderError()) {
              // FULL tree token budget: debit input+output+reasoning; stop when exhausted.
              const used =
                stepSettlement.tokens.input +
                stepSettlement.tokens.output +
                stepSettlement.tokens.reasoning
              const tree = yield* drain.treeBudget.debit(used)
              if (tree.exhausted) {
                yield* drain.terminal.request("budget_exhausted")
                needsContinuation = false
              }
              yield* withPublication(
                events.publish(SessionEvent.Step.Ended, {
                  sessionID: session.id,
                  timestamp: yield* DateTime.now,
                  assistantMessageID: yield* publisher.startAssistant(),
                  finish: stepSettlement.finish,
                  cost: costOf(stepSettlement.tokens, modelInfo),
                  tokens: stepSettlement.tokens,
                  snapshot: endSnapshot,
                  files,
                  ...(stepSettlement.copilotNanoAiu === undefined
                    ? {}
                    : { copilotNanoAiu: stepSettlement.copilotNanoAiu }),
                }),
              )
              // Persist unified diffs onto session.summary for TUI diff panel (V1 parity).
              yield* persistStepDiffs(session.id, startSnapshot, endSnapshot, files).pipe(Effect.ignore, Effect.forkScoped)
              if (stepSettlement.tokens.cache.read > 0 || stepSettlement.tokens.input > 0) {
                const read = stepSettlement.tokens.cache.read
                const uncached = stepSettlement.tokens.input
                yield* Effect.log(
                  `cache_hit steady=${hitRate({ cacheReadInputTokens: read, nonCachedInputTokens: uncached })} read=${read} uncached=${uncached}`,
                )
              }
            }
            if (publisher.hasProviderError())
              yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (stream._tag === "Success" && !publisher.hasProviderError())
              yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            if (pendingTape) {
              const seq = yield* EventV2.latestSequence(db, session.id)
              PromptTapeStore.setLastSeq(session.id, system.baselineSeq, seq)
              if (pendingAdded > 0) {
                PromptTapeStore.appendMessageSeqs(
                  session.id,
                  system.baselineSeq,
                  Array.from({ length: pendingAdded }, () => seq),
                )
              }
              yield* persistTape(session.id, system.baselineSeq, pendingTape)
            }
            if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause)) {
              return yield* Effect.failCause(settled.cause)
            }
            return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
          }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      drain: DrainContext,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, drain) {
      return yield* runTurnAttempt(sessionID, promotion, step, drain).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction") {
              // Defensive: post-compaction path should not request another overflow
              // recovery. Publish a durable failure so the UI shows why the turn died.
              yield* events
                .publish(SessionEvent.Step.Failed, {
                  sessionID,
                  timestamp: yield* DateTime.now,
                  assistantMessageID: SessionMessage.ID.create(),
                  error: {
                    type: "unknown",
                    message:
                      "Context still overflows after compaction; cannot recover another overflow in this turn.",
                  },
                })
                .pipe(Effect.catchCause(() => Effect.void))
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            }
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, drain)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, drain) {
      let needsContinuation = false
      const runTurnCore: RunTurn = Effect.fnUntraced(function* (
        sessionID: SessionSchema.ID,
        promotion: SessionInput.Delivery | undefined,
        step: number,
        drain: DrainContext,
      ) {
        return yield* runTurnAttempt(sessionID, promotion, step, drain, compaction.compactAfterOverflow).pipe(
          Effect.map((result) => {
            needsContinuation = result.needsContinuation
            return result
          }),
          Effect.catchDefect(
            Effect.fnUntraced(function* (defect) {
              if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
              yield* Effect.yieldNow
              if (defect.transition._tag === "ContinueAfterOverflowCompaction") {
                const replayed = yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, drain)
                needsContinuation = replayed.needsContinuation
                return replayed
              }
              return yield* runTurnCore(sessionID, undefined, defect.transition.step, drain)
            }),
          ),
        )
      })
      const result = yield* runTurnCore(sessionID, promotion, step, drain).pipe(
        Effect.ensuring(drain.hooks.onTurnEnd({ sessionID, needsContinuation })),
      )
      return result
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return

      // Drive the same session.status events the TUI/App already consume (spinner,
      // interrupt enablement). Previously only the legacy prompt/processor path
      // called SessionStatus.set, so V2 drains left the UI stuck on idle.
      yield* events.publish(SessionStatusEvent.Status, {
        sessionID: input.sessionID,
        status: { type: "busy" },
      })

      yield* Effect.gen(function* () {
        yield* failInterruptedTools(input.sessionID)
        const drain = yield* buildDrainContext(input.sessionID)
        let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
        let shouldRun = input.force || hasSteer || hasQueue
        let extra = 0
        // Explicit resume/steer/queue may run one turn after session.interrupt.
        // user_abort is not reset (freeze); only automatic continuation is blocked.
        let firstTurn = true
        while (shouldRun) {
          if (
            !firstTurn &&
            drain.hooks.shouldContinue &&
            !(yield* drain.hooks.shouldContinue(input.sessionID))
          )
            break
          let needsContinuation = true
          let step = 1
          while (needsContinuation) {
            if (
              !firstTurn &&
              drain.hooks.shouldContinue &&
              !(yield* drain.hooks.shouldContinue(input.sessionID))
            ) {
              needsContinuation = false
              break
            }
            const result = yield* runTurn(input.sessionID, promotion, step, drain)
            firstTurn = false
            needsContinuation = result.needsContinuation
            step = result.step + 1
            promotion = "steer"
            if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
          }
          shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
          promotion = shouldRun ? "queue" : undefined
          if (!shouldRun && extra < 4) {
            const msgs = yield* store.context(input.sessionID).pipe(
              Effect.catch(() => Effect.succeed([] as SessionMessage.Message[])),
            )
            const last = msgs.at(-1)
            // V1 runLoop kept going after shellImpl (no finish on that assistant).
            // A trailing shell message is unanswered work. Do not treat a user
            // without an assistant row as unanswered after an empty provider
            // body — that would re-issue the same turn up to `extra` times.
            if (last?.type === "shell") {
              extra += 1
              shouldRun = true
              promotion = undefined
            }
          }
          if (shouldRun) continue
          if (drain.hooks.shouldContinue && !(yield* drain.hooks.shouldContinue(input.sessionID))) break
        }
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* events
              .publish(SessionStatusEvent.Status, {
                sessionID: input.sessionID,
                status: { type: "idle" },
              })
              .pipe(Effect.catchCause(() => Effect.void))
            yield* Hooks.fire({ event: "Stop", sessionID: input.sessionID }).pipe(Effect.ignore)
            // SessionIdle lifecycle for subagent contributor hooks
            const lifeOpt = yield* Effect.serviceOption(SubagentLifecycle.Service)
            if (Option.isSome(lifeOpt)) {
              yield* lifeOpt.value
                .dispatch({ _tag: "SessionIdle", sessionID: input.sessionID })
                .pipe(Effect.ignore)
            }
          }),
        ),
      )
    }, Effect.scoped)

    const compact = Effect.fn("SessionRunner.compact")(function* (sessionID: SessionSchema.ID) {
      const session = yield* getSession(sessionID)
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContextAndRecall(agent, session.id), session.id)
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContextAndRecall(agent, session.id), session.id))
      const model = yield* models.resolve(session)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      // Budget must count real system context. Tools stay empty — manual compact
      // does not materialize a tool turn.
      const request = LLM.request({
        model,
        system: [agent.info?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [],
        tools: [],
      })
      yield* compaction.compactAfterOverflow({
        sessionID: session.id,
        entries,
        model,
        request,
        reason: "manual",
      })
      yield* dropTape(sessionID)
    })

    return Service.of({
      run: (input) => provideRunnerGlobals(run(input)),
      compact: (sessionID) => provideRunnerGlobals(compact(sessionID)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    Catalog.node,
    SessionStore.node,
    Location.node,
    FSUtil.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
    SessionRuntime.node,
    llmClient,
  ],
})
