import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { Cause, DateTime, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { LoopControlHost, type LoopControlHooks } from "./loop-control-host"
import { IterationBudget } from "../loop-control/iteration-budget"
import { TimerDaemon } from "../loop-control/timer-daemon"
import { TerminalController } from "../loop-control/terminal-controller"
import { ContextEngine } from "./context-engine"
import { VerifierBiDirectional, type NextTurnSystemContext } from "./verifier-bi-directional"
import { SessionRuntime, type Instance } from "../runtime"

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
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const runtime = yield* SessionRuntime.Service
    const db = (yield* Database.Service).db
    const compaction = SessionCompaction.make({ events, llm, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
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
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

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
      readonly contextEngine: ContextEngine.Interface
      readonly budget: IterationBudget.Interface
      readonly terminal: TerminalController.Interface
      readonly verifierBiDirectional: VerifierBiDirectional.Interface
    }

    /**
     * Render one drained verifier-reject feedback slice into a single
     * model-visible system-context text. Returns the empty string when both
     * the reason and the evidence are empty, so the caller can omit the
     * SystemPart entirely and avoid duplicating the static baseline parts.
     * The rendering is intentionally stable and self-describing so a snapshot
     * test can pin its shape without coupling to wiring.
     */
    const renderVerifierFeedback = (next: NextTurnSystemContext): string => {
      if (next.verifier_reject_reason.length === 0 && next.verifier_reject_evidence.length === 0) return ""
      const lines = [`<verifier-feedback reason=${JSON.stringify(next.verifier_reject_reason)}>`]
      if (next.verifier_reject_reason.length > 0) lines.push(`reason: ${next.verifier_reject_reason}`)
      for (const item of next.verifier_reject_evidence) {
        const loc = item.line === undefined ? item.file : `${item.file}:${item.line}`
        lines.push(`evidence: ${loc} — ${item.issue}`)
      }
      lines.push("</verifier-feedback>")
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
      const hooks = yield* LoopControlHost.makeSessionHooks(sessionID, instance).pipe(
        Effect.provideService(LLMClient.Service, llm),
      )
      yield* instance.timerDaemon.start.pipe(Effect.forkScoped)
      return {
        hooks,
        timerDaemon: instance.timerDaemon,
        contextEngine: instance.contextEngine,
        budget: instance.budget,
        terminal: instance.terminal,
        verifierBiDirectional: instance.verifierBiDirectional,
      }
    })

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      drain: DrainContext,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      yield* drain.hooks.onTurnStart({ sessionID: session.id, step })
      if (drain.hooks.shouldContinue && !(yield* drain.hooks.shouldContinue(session.id)))
        return { needsContinuation: false, step }
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
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
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id))
      const model = yield* models.resolve(session)
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
      const context = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize(agent.info?.permissions)
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const request = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        system: [agent.info?.system, system.baseline, verifierFeedback]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [...toLLMMessages(context, model), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      if (yield* drain.contextEngine.shouldProactiveCompact) {
        if (yield* compaction.compactAfterOverflow({ sessionID: session.id, entries, model, request })) {
          yield* drain.contextEngine.compact
          return yield* Effect.die(continueAfterCompaction(currentStep))
        }
      }
      const startSnapshot = yield* snapshots.capture()
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
      let overflowFailure: ProviderErrorEvent | undefined
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            yield* publish(event)
            yield* drain.hooks.onStream({ _tag: "chunk", sessionID: session.id })
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            yield* drain.hooks.onToolCall({ name: event.name, callID: event.id, sessionID: session.id })
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
          ) {
            // Context-overflow recovery via compaction succeeded; do not route
            // through onFailover (a non-retryable classification would wrongly
            // request terminal failure when the turn legitimately replays).
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          }
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted"))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          const stepSettlement = publisher.stepSettlement()
          const endSnapshot = yield* snapshots.capture()
          const files =
            startSnapshot && endSnapshot
              ? yield* snapshots
                  .files({ from: startSnapshot, to: endSnapshot })
                  .pipe(Effect.catch(() => Effect.succeed(undefined)))
              : undefined
          // Verifier audit only runs on a genuinely successful stream; a failed
          // provider stream must not audit a partial or empty claim.
          if (stream._tag === "Success" && !publisher.hasProviderError()) {
            yield* drain.hooks.onStreamComplete({
              sessionID: session.id,
              finishReason: stepSettlement?.finish ?? "stop",
              workerClaim: publisher.assistantText(),
              workerDiffPath: files?.join("\n") ?? "",
              model,
            })
          }
          // onStreamComplete may request a terminal state (verifier approval,
          // verifier failure, hard abort). When it does, no further provider
          // continuation should be offered even if the stream produced tool calls.
          if (drain.hooks.shouldContinue && !(yield* drain.hooks.shouldContinue(session.id))) {
            needsContinuation = false
            return { needsContinuation: false, step: currentStep }
          }
          if (stepSettlement && !publisher.hasProviderError()) {
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                cost: 0,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") {
            // Classify the failure once for loop-control observation: a
            // non-retryable or repeated reason requests terminal
            // unrecoverable_failure so the outer drain stops. The runner does
            // not replay the provider turn here; the original error is
            // propagated so a later explicit resume can retry.
            const err = failure instanceof LLMError ? failure : undefined
            if (err && !publisher.hasProviderError()) {
              yield* drain.hooks.onFailover(err)
            }
            return yield* Effect.failCause(stream.cause)
          }
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause)) {
            return yield* Effect.failCause(settled.cause)
          }
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
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
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
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
      yield* failInterruptedTools(input.sessionID)
      const drain = yield* buildDrainContext(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        while (needsContinuation) {
          const result = yield* runTurn(input.sessionID, promotion, step, drain)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        // Turn boundary: a terminal request (verifier approval, abort, timeout,
        // budget exhaustion, unrecoverable failure) is authoritative — stop
        // promoting queued inputs once the controller is no longer continuing.
        if (drain.hooks.shouldContinue && !(yield* drain.hooks.shouldContinue(input.sessionID))) break
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
      }
    }, Effect.scoped)

    return Service.of({
      run,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
    SessionRuntime.node,
  ],
})
