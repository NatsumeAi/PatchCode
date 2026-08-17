export * as LoopControlHost from "./loop-control-host"

import { LLMClient, LLMError, type LLMClientShape, type Model } from "@opencode-ai/llm"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { Context, Effect, Layer, Option, Scope, SynchronizedRef } from "effect"
import { llmClient } from "../../effect/app-node-platform"
import { makeGlobalNode } from "../../effect/app-node"
import { WorkerState } from "../loop-control/worker-state"
import { EventBus } from "../loop-control/event-bus"
import { IterationBudget } from "../loop-control/iteration-budget"
import { TimerDaemon } from "../loop-control/timer-daemon"
import { TerminalController } from "../loop-control/terminal-controller"
import { CircuitBreaker } from "../loop-control/circuit-breaker"
import { DoomLoop } from "../loop-control/doom-loop"
import { PermissionV2 } from "../../permission"
import { SessionSchema } from "../schema"
import { ErrorClassifier } from "./error-classifier"
import { TurnRetryState } from "./turn-retry-state"
import { GoalStore } from "../loop-control/goal-store"
import { Verifier } from "./verifier"
import { DoneDecisionLoop } from "./done-decision-loop"
import { VerifierBiDirectional } from "./verifier-bi-directional"
import type * as SessionRuntime from "../runtime"

/**
 * LoopControlHost — stable hook contract for the 8机关 runtime to attach into
 * opencode's `llm.ts` runTurn pipeline without modifying orchestration logic.
 *
 * Per docs/loop-design.md §10 决议 4: hook signature fixed as
 * `onTurnStart / onStream / onToolCall / onStreamComplete / onFailover / onTurnEnd`
 *
 * Default impl is no-op (`Effect.void` / `{ recovered: false }`) so llm.ts
 * behavior is unchanged when no loop-control layer is wired. Plan 3 fills in
 * the actual 机关 logic (Done-ness Verifier, IterationBudget consume, etc).
 */

export interface TurnStartCtx {
  readonly sessionID: string
  readonly step: number
  /** Provider id for per-provider circuit breaker routing (W2). */
  readonly providerID?: string
}

export interface StreamEvent {
  readonly _tag: "chunk" | "reasoning" | "usage"
  readonly sessionID: string
}

export interface ToolCall {
  readonly name: string
  readonly callID: string
  readonly sessionID: string
  /** Tool args for doom-loop fingerprint (name+args hash). Optional for back-compat. */
  readonly input?: unknown
}

export interface StreamOutput {
  readonly sessionID: string
  readonly finishReason: string
  readonly workerClaim: string
  readonly workerDiffPath: string
  readonly model: Model
}

export interface FailoverResult {
  readonly recovered: boolean
}

export interface TurnEndCtx {
  readonly sessionID: string
  readonly needsContinuation: boolean
}

export interface LoopControlHooks {
  readonly onTurnStart: (ctx: TurnStartCtx) => Effect.Effect<void>
  readonly shouldContinue?: (sessionID: string) => Effect.Effect<boolean>
  readonly onStream: (event: StreamEvent) => Effect.Effect<void>
  readonly onToolCall: (call: ToolCall) => Effect.Effect<void>
  readonly onStreamComplete: (out: StreamOutput) => Effect.Effect<void>
  readonly onFailover: (cause: unknown) => Effect.Effect<FailoverResult>
  readonly onTurnEnd: (ctx: TurnEndCtx) => Effect.Effect<void>
}

export const Interface = Context.Service<LoopControlHooks>("@opencode/Runner/LoopControlHost")

export const noopHooks: LoopControlHooks = {
  onTurnStart: () => Effect.void,
  shouldContinue: () => Effect.succeed(true),
  onStream: () => Effect.void,
  onToolCall: () => Effect.void,
  onStreamComplete: () => Effect.void,
  onFailover: () => Effect.succeed({ recovered: false }),
  onTurnEnd: () => Effect.void,
}

export const layerNoop: Layer.Layer<LoopControlHooks> = Layer.succeed(Interface, noopHooks)

export const nodeNoop = makeGlobalNode({ service: Interface, layer: layerNoop, deps: [] })

/**
 * Per-session owner-session-ID accessor used to filter EventBus events.
 *
 * `makeSessionHooks` is bound to exactly one session ID at factory time, so
 * its instance is fixed (`FixedOwner`). `layerReal` preserves its legacy
 * behavior of setting the owner via the first `onTurnStart` call, so it
 * builds a `MutableOwner` over a `SynchronizedRef<string | undefined>`.
 */
type OwnerSessionRef =
  | { readonly kind: "fixed"; readonly sessionID: string }
  | { readonly kind: "mutable"; readonly get: Effect.Effect<string | undefined>; readonly set: (v: string) => Effect.Effect<void> }

const buildRealHooks = (
  owner: OwnerSessionRef,
  instance: LoopControlInstanceServices,
  llm: LLMClientShape,
): Effect.Effect<LoopControlHooks, never, Scope.Scope> =>
  Effect.gen(function* () {
    const abortRequested = yield* SynchronizedRef.make(false)
    const recentClaims = yield* SynchronizedRef.make<string[]>([])
    const recentToolFingerprints = yield* SynchronizedRef.make<string[]>([])
    const doomLoopAsked = yield* SynchronizedRef.make(false)
    const verifiers = new Map<string, { readonly goal: string; readonly verifier: Verifier.VerifierImpl }>()
    const disposeVerifiers = Effect.fnUntraced(function* () {
      for (const { verifier } of verifiers.values()) yield* verifier.dispose
      verifiers.clear()
    })
    const getVerifier = Effect.fnUntraced(function* (out: StreamOutput, goal: string) {
      const current = verifiers.get(out.sessionID)
      if (current?.goal === goal) return current.verifier
      if (current) yield* current.verifier.dispose
      const verifier = yield* Verifier.make({
        parentSessionID: out.sessionID,
        goal,
        auditor: Verifier.makeProviderAuditor(out.model, llm),
      })
      verifiers.set(out.sessionID, { goal, verifier })
      return verifier
    })
    const unsubscribe = yield* instance.eventBus.subscribe((event) =>
      Effect.gen(function* () {
        const currentOwner =
          owner.kind === "fixed" ? owner.sessionID : yield* owner.get
        switch (event._tag) {
          case "AbortRequested":
          case "HardAbort":
            yield* SynchronizedRef.set(abortRequested, true)
            yield* disposeVerifiers()
            yield* instance.workerState.transition({ _tag: "Dead", reason: "ParentAbort" }).pipe(Effect.ignore)
            return
          case "SubagentCompleted":
            if (currentOwner !== event.parentSessionID) return
            yield* instance.workerState.transition({ _tag: "Active" }).pipe(Effect.ignore)
            return
          case "SubagentFailed":
            if (currentOwner !== event.parentSessionID) return
            yield* SynchronizedRef.set(abortRequested, true)
            yield* disposeVerifiers()
            yield* instance.workerState.transition({ _tag: "Dead", reason: "ParentAbort" }).pipe(Effect.ignore)
            return
          case "StopReminder":
            // FULL harness effect: inject timer reminder into next-turn system context
            // (separate channel from verifier rejects).
            yield* instance.verifierBiDirectional
              .injectTimerReminder(
                `Stop reminder: ${event.reason}. Progress under harness observation — finish the goal or request stop.`,
              )
              .pipe(Effect.provideService(EventBus.Service, instance.eventBus))
            return
          case "WaitIdleBackupTick":
            // Only real timer idle checks inject (not every turn_end publish).
            if (event.reason === "idle_status_check") {
              yield* instance.verifierBiDirectional
                .injectTimerReminder(
                  `Wait/idle backup: ${event.reason}. Harness is still waiting on background work or idle state.`,
                )
                .pipe(Effect.provideService(EventBus.Service, instance.eventBus))
            }
            return
          case "LoopTerminated":
            if (event.reason === "loop_timer_reached_24h") {
              yield* instance.terminal.request("hard_timeout")
              yield* SynchronizedRef.set(abortRequested, true)
            }
            return
          default:
            return
        }
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    yield* Effect.addFinalizer(disposeVerifiers)

    const lastProvider = yield* SynchronizedRef.make<string>("default")
    const hooks: LoopControlHooks = {
      onTurnStart: (ctx) =>
        Effect.gen(function* () {
          if (owner.kind === "mutable") yield* owner.set(ctx.sessionID)
          if (yield* SynchronizedRef.get(abortRequested)) return
          const key = ctx.providerID?.trim() || "default"
          yield* SynchronizedRef.set(lastProvider, key)
          // allowRequest: Closed always; HalfOpen claims a single probe slot; Open blocks.
          const allowed = yield* instance.circuitBreaker.allowRequest(key)
          if (!allowed) {
            // Half-open probe already claimed (or Open): stop this turn so we
            // do not send a second stream while shouldContinue still sees HalfOpen.
            yield* SynchronizedRef.set(abortRequested, true)
            return
          }
          yield* instance.retry.reset
          yield* instance.workerState.transition({ _tag: "Active" }).pipe(Effect.ignore)
          // Budget consume moved to the runner after agents.select/models.resolve succeed
          // (see #23: pre-debiting before model selection wastes budget on failures).
          yield* instance.eventBus.publish({ _tag: "HookTurnStart", sessionID: ctx.sessionID, step: ctx.step })
        }),
      shouldContinue: (_sessionID: string) =>
        Effect.gen(function* () {
          const aborted = yield* SynchronizedRef.get(abortRequested)
          if (aborted) return false
          // Do not claim a probe here — only block when fully Open.
          const key = yield* SynchronizedRef.get(lastProvider)
          const breaker = yield* instance.circuitBreaker.stateFor(key)
          if (breaker === "Open") return false
          return yield* instance.terminal.shouldContinue
        }),
      onStream: () => Effect.void,
      onToolCall: (call) =>
        Effect.gen(function* () {
          yield* instance.eventBus.publish({ _tag: "HookToolCall", sessionID: call.sessionID, name: call.name })
          // Fingerprint = name + stable args hash (plan: same tool name+args ≥ K).
          // Parallel different-args same-name tools do not match; true retry loops do.
          const fp = DoomLoop.toolFingerprint(call.name, call.input)
          const next = yield* SynchronizedRef.updateAndGet(recentToolFingerprints, (xs) => [...xs, fp].slice(-24))
          const hard = DoomLoop.detectRepeatedToolFingerprint(next, DoomLoop.HARD_ABORT_THRESHOLD)
          if (hard) {
            yield* instance.terminal.request("unrecoverable_failure")
            yield* instance.eventBus.publish({
              _tag: "HardAbort",
              reason: `doom_loop_tool_${hard.signal.kind}`,
            })
            yield* SynchronizedRef.set(abortRequested, true)
            return
          }
          const asked = yield* SynchronizedRef.get(doomLoopAsked)
          if (asked || !DoomLoop.detectRepeatedToolFingerprint(next, DoomLoop.ASK_THRESHOLD)) return
          yield* SynchronizedRef.set(doomLoopAsked, true)
          const permission = yield* Effect.serviceOption(PermissionV2.Service)
          if (Option.isNone(permission)) return
          const result = yield* permission.value
            .assert({
              sessionID: SessionSchema.ID.make(call.sessionID),
              action: "doom_loop",
              resources: [call.name],
              metadata: { tool: call.name, input: call.input ?? {} },
            })
            .pipe(Effect.exit)
          if (result._tag === "Failure") {
            yield* instance.terminal.request("unrecoverable_failure")
            yield* instance.eventBus.publish({
              _tag: "HardAbort",
              reason: "doom_loop_permission_denied",
            })
            yield* SynchronizedRef.set(abortRequested, true)
          }
        }),
      onStreamComplete: (out) =>
        Effect.gen(function* () {
          // Only treat natural stop finishes as done-claims. Tool-call turns are
          // mid-loop and must not fire verifier / doom-loop claim tracking.
          const finish = out.finishReason.toLowerCase()
          const looksDone =
            finish === "stop" ||
            finish === "end_turn" ||
            finish === "completed" ||
            finish === "length" ||
            finish === "max_tokens"
          if (!looksDone) return

          // Doom-loop: repeated identical assistant claims.
          if (out.workerClaim.trim()) {
            const claims = yield* SynchronizedRef.updateAndGet(recentClaims, (xs) =>
              [...xs, out.workerClaim].slice(-8),
            )
            const signal = DoomLoop.detectTailRepetition(claims)
            if (signal) {
              yield* instance.terminal.request("unrecoverable_failure")
              yield* instance.eventBus.publish({
                _tag: "HardAbort",
                reason: `doom_loop_claim_${signal.signal.kind}`,
              })
              yield* SynchronizedRef.set(abortRequested, true)
              return
            }
          }

          const goal = yield* instance.goalStore.get
          if (!goal) return
          // Empty claims (common on pure tool-finish→stop without assistant prose) are
          // not auditable; skip rather than hard-aborting the drain.
          if (!out.workerClaim.trim()) return
          // FULL D1: auto-seeded and explicit goals both enable verifier.
          const verifier = yield* getVerifier(out, goal)
          const outcome = yield* DoneDecisionLoop.onWorkerClaimComplete(verifier, {
            worker_claim: out.workerClaim,
            worker_diff_path: out.workerDiffPath,
          })
            .pipe(
              Effect.provideService(VerifierBiDirectional.Service, instance.verifierBiDirectional),
              Effect.provideService(EventBus.Service, instance.eventBus),
              Effect.provideService(TerminalController.Service, instance.terminal),
            )
            .pipe(Effect.exit)
          if (outcome._tag === "Success") {
            if (outcome.value.broken) {
              verifiers.delete(out.sessionID)
              yield* verifier.dispose
              yield* instance.circuitBreaker.recordSuccessFor(yield* SynchronizedRef.get(lastProvider))
              yield* instance.eventBus.publish({ _tag: "LoopTerminated", reason: "verifier_approved" })
            }
            return
          }
          // Auditor/provider failure: soft-inject reject reason and continue the
          // loop (do not HardAbort the parent drain — only N=8 reject cap / terminal
          // controller may stop). HardAbort reserved for AbortRequested / doom / CB.
          verifiers.delete(out.sessionID)
          yield* verifier.dispose
          const errText = String(outcome.cause)
          yield* instance.verifierBiDirectional
            .injectRejectReasonToWorkerContext(
              `Verifier audit failed (will retry next claim): ${errText.slice(0, 500)}`,
              [],
            )
            .pipe(Effect.provideService(EventBus.Service, instance.eventBus))
          yield* instance.circuitBreaker.recordFailureFor(yield* SynchronizedRef.get(lastProvider))
        }),
      onFailover: (cause) =>
        Effect.gen(function* () {
          const shape =
            typeof cause === "object" && cause !== null
              ? (cause as { type?: unknown; status?: unknown })
              : {}
          const classified = yield* ErrorClassifier.classifyApiError(
            cause instanceof LLMError
              ? cause
              : {
                  type: typeof shape.type === "string" ? shape.type : "unknown",
                  ...(typeof shape.status === "number" ? { status: shape.status } : {}),
                },
          )
          // Only a transient reason on its first one-shot admission recovers;
          // non-retryable failures and exhausted retries both request a
          // terminal unrecoverable_failure so the runner stops the drain.
          const first = yield* instance.retry.consume(classified.reason)
          const recovered = classified.retryable && first
          if (!recovered) {
            yield* instance.circuitBreaker.recordFailureFor(yield* SynchronizedRef.get(lastProvider))
            yield* instance.terminal.request("unrecoverable_failure")
            yield* instance.eventBus.publish({ _tag: "HardAbort", reason: `unrecoverable_${classified.reason}` })
          }
          // Recovered retry is not a provider success — do not reset the window.
          return { recovered }
        }),
      onTurnEnd: (ctx) =>
        Effect.gen(function* () {
          if (ctx.needsContinuation) {
            yield* instance.workerState.transition({ _tag: "Active" }).pipe(Effect.ignore)
          } else {
            yield* instance.workerState.transition({ _tag: "Waiting", reason: "OnBackgroundExec" }).pipe(Effect.ignore)
          }
          yield* instance.eventBus.publish({ _tag: "WaitIdleBackupTick", reason: "turn_end" })
          yield* instance.eventBus.publish({ _tag: "HookTurnEnd", sessionID: ctx.sessionID })
        }),
    }

    return hooks
  })

/**
 * Nominal bundle of per-session mutable services consumed by the real hooks.
 * `layerReal` derives one from its singleton service layers (legacy contract);
 * `makeSessionHooks` reads the bundle directly off a `SessionRuntime.Instance`.
 */
interface LoopControlInstanceServices {
  readonly workerState: WorkerState.Interface
  readonly eventBus: EventBus.Interface
  readonly budget: IterationBudget.Interface
  readonly retry: TurnRetryState.Interface
  readonly goalStore: GoalStore.Interface
  readonly verifierBiDirectional: VerifierBiDirectional.Interface
  readonly terminal: TerminalController.Interface
  readonly circuitBreaker: CircuitBreaker.Interface
}

/**
 * Session-bound loop-control hooks factory (Plan Task 2).
 *
 * Binds a `LoopControlHooks` to exactly one session ID and the mutable per-session
 * services in the supplied `SessionRuntime.Instance`. The location-scoped
 * `LLMClient.Service` is resolved from the Effect environment at factory time so
 * the global `SessionRuntime` registry never depends on `LLMClient` at construction
 * — it can live process-globally while the client is wired at the runner boundary.
 *
 * The returned `Effect` runs in the caller's `Scope`: the EventBus subscription
 * and the per-session verifier Map are disposed when that scope finalizes, so the
 * verifier/abort state of one session never leaks into another. The owner session
 * ID is fixed at factory time (not a mutable global) — a `SubagentFailed` whose
 * `parentSessionID` differs from `sessionID` is ignored, leaving that session's
 * worker alive and `shouldContinue` true.
 */
export const makeSessionHooks = (
  sessionID: string,
  instance: SessionRuntime.Instance,
): Effect.Effect<LoopControlHooks, never, LLMClientService | Scope.Scope> =>
  Effect.gen(function* () {
    const llm = yield* LLMClient.Service
    const services: LoopControlInstanceServices = {
      workerState: instance.workerState,
      eventBus: instance.eventBus,
      budget: instance.budget,
      retry: instance.retry,
      goalStore: instance.goalStore,
      verifierBiDirectional: instance.verifierBiDirectional,
      terminal: instance.terminal,
      circuitBreaker: instance.circuitBreaker,
    }
    return yield* buildRealHooks({ kind: "fixed", sessionID }, services, llm)
  })

/**
 * Real loop-control hooks layer (legacy single-session contract).
 *
 * Built once from a single set of singleton service layers; the owner session
 * ID is set lazily by the first `onTurnStart` call and used to filter EventBus
 * events (`SubagentCompleted` / `SubagentFailed`) so the existing
 * `loop-control-host-layerreal` and `llm-loop-control` test contracts are
 * preserved verbatim. New session-bound wiring that needs true per-session
 * isolation should use `makeSessionHooks` instead.
 *
 * Finalizers are process-lifetime: the layer's outer `Scope` (the app/process
 * scope that builds it) owns its EventBus subscription and verifier Map, so
 * they are never torn down per-session unlike `makeSessionHooks` (which is the
 * scoped replacement).
 *
 * - onTurnStart  → WorkerState → Active; retry.reset; publish (budget consume
 *   happens in the runner after agents.select/models.resolve succeed — #23)
 * - onStream     → publish Heartbeat-ish chunk event
 * - onToolCall   → publish
 * - onStreamComplete → publish (done-decision wiring needs claim data that the
 *   hook contract does not carry — see Wiring A-1 finding)
 * - onFailover   → ErrorClassifier.classify + TurnRetryState.consume + publish
 * - onTurnEnd    → WorkerState → Waiting; publish
 */
export const layerReal: Layer.Layer<
  LoopControlHooks,
  never,
  | WorkerState.Interface
  | EventBus.Interface
  | IterationBudget.Interface
  | TimerDaemon.Interface
  | TurnRetryState.Interface
  | GoalStore.Interface
  | VerifierBiDirectional.Interface
  | TerminalController.Interface
  | CircuitBreaker.Interface
  | LLMClientService
> = Layer.effect(
  Interface,
  Effect.gen(function* () {
    const workerState = yield* WorkerState.Service
    const eventBus = yield* EventBus.Service
    const budget = yield* IterationBudget.Service
    yield* TimerDaemon.Service
    const retry = yield* TurnRetryState.Service
    const goalStore = yield* GoalStore.Service
    const vbd = yield* VerifierBiDirectional.Service
    const terminal = yield* TerminalController.Service
    const circuitBreaker = yield* CircuitBreaker.Service
    const llm = yield* LLMClient.Service
    const ownerSessionID = yield* SynchronizedRef.make<string | undefined>(undefined)
    const owner: OwnerSessionRef = {
      kind: "mutable",
      get: SynchronizedRef.get(ownerSessionID),
      set: (v) => SynchronizedRef.set(ownerSessionID, v),
    }
    const services: LoopControlInstanceServices = {
      workerState,
      eventBus,
      budget,
      retry,
      goalStore,
      verifierBiDirectional: vbd,
      terminal,
      circuitBreaker,
    }
    return yield* buildRealHooks(owner, services, llm)
  }),
)

export const nodeReal = makeGlobalNode({
  service: Interface,
  layer: layerReal,
  deps: [
    WorkerState.node,
    EventBus.node,
    llmClient,
    IterationBudget.node,
    TimerDaemon.node,
    TurnRetryState.node,
    GoalStore.node,
    VerifierBiDirectional.node,
    TerminalController.node,
    CircuitBreaker.node,
  ],
})

export const onTurnStart = (ctx: TurnStartCtx): Effect.Effect<void, never, LoopControlHooks> =>
  Effect.gen(function* () {
    const hooks = yield* Interface
    yield* hooks.onTurnStart(ctx)
  })

export const onStream = (event: StreamEvent): Effect.Effect<void, never, LoopControlHooks> =>
  Effect.gen(function* () {
    const hooks = yield* Interface
    yield* hooks.onStream(event)
  })

export const onToolCall = (call: ToolCall): Effect.Effect<void, never, LoopControlHooks> =>
  Effect.gen(function* () {
    const hooks = yield* Interface
    yield* hooks.onToolCall(call)
  })

export const onStreamComplete = (out: StreamOutput): Effect.Effect<void, never, LoopControlHooks> =>
  Effect.gen(function* () {
    const hooks = yield* Interface
    yield* hooks.onStreamComplete(out)
  })

export const onFailover = (cause: unknown): Effect.Effect<FailoverResult, never, LoopControlHooks> =>
  Effect.gen(function* () {
    const hooks = yield* Interface
    return yield* hooks.onFailover(cause)
  })

export const onTurnEnd = (ctx: TurnEndCtx): Effect.Effect<void, never, LoopControlHooks> =>
  Effect.gen(function* () {
    const hooks = yield* Interface
    yield* hooks.onTurnEnd(ctx)
  })
