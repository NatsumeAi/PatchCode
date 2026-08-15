export * as SessionRuntime from "./runtime"

import { Context, Effect, Layer, Schema, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { WorkerState } from "./loop-control/worker-state"
import { EventBus } from "./loop-control/event-bus"
import { IterationBudget } from "./loop-control/iteration-budget"
import { TerminalController } from "./loop-control/terminal-controller"
import { TimerDaemon } from "./loop-control/timer-daemon"
import { CircuitBreaker } from "./loop-control/circuit-breaker"
import { TurnRetryState } from "./runner/turn-retry-state"
import { GoalStore } from "./loop-control/goal-store"
import { VerifierBiDirectional } from "./runner/verifier-bi-directional"
import { ContextEngine } from "./runner/context-engine"
import { TreeBudget } from "./tree-budget"

/**
 * SessionRuntime — process-local, session-ID-keyed registry of mutable
 * loop-control service bundles. One drain owns one bundle; different sessions
 * never share mutable service instances (terminal, budget, workerState, ...).
 *
 * Scope: process-local. Not durable, not cross-process. The durable admission
 * layer and clustered ownership are separate concerns.
 *
 * The registry owns the location-independent mutable bundle. Session-bound
 * hooks are built at the runner drain boundary because they also require the
 * location-scoped `LLMClientService`.
 *
 * Concurrency: the registry `Map` mutation is guarded by `SynchronizedRef`
 * so concurrent `getOrCreate`/`resetForDrain`/`release` fibers reconcile
 * atomically. Each `Instance`'s internal services use their own
 * `SynchronizedRef`s (WorkerState, TerminalController, IterationBudget, ...).
 */

/**
 * Per-session loop-control service bundle. Hooks are intentionally not stored
 * here: their verifier auditor is pinned to the location-scoped LLM client for
 * one drain scope and is built by `LoopControlHost.makeSessionHooks`.
 */
export interface Instance {
  readonly sessionID: string
  readonly workerState: WorkerState.Interface
  readonly eventBus: EventBus.Interface
  readonly terminal: TerminalController.Interface
  readonly budget: IterationBudget.Interface
  readonly retry: TurnRetryState.Interface
  readonly goalStore: GoalStore.Interface
  readonly verifierBiDirectional: VerifierBiDirectional.Interface
  readonly timerDaemon: TimerDaemon.Interface
  readonly contextEngine: ContextEngine.Interface
  readonly circuitBreaker: CircuitBreaker.Interface
  readonly treeBudget: TreeBudget.Interface
  /** Open SpawnEdges for children of this session (childSessionID → edge). */
  readonly spawnEdges: Map<string, import("./loop-control/spawn-edge").SpawnEdge>
  /** Active agent guards for in-flight children (released on child terminal). */
  readonly agentGuards: Map<string, IterationBudget.AgentGuard>
}

export interface Interface {
  /**
   * Returns the bundle for `sessionID`, lazily creating it on first access.
   * Idempotent per session ID: a second call with the same ID returns the
   * exact same `Instance` and its mutable services (terminal, budget, ...).
   */
  readonly getOrCreate: (sessionID: string) => Effect.Effect<Instance>
  /**
   * Returns the existing bundle for `sessionID`, or fails with
   * `SessionNotFound` if none has been created.
   */
  readonly current: (sessionID: string) => Effect.Effect<Instance, SessionNotFound>
  /**
   * Resets the mutable per-session state (budget, retry, worker, breaker)
   * for `sessionID` without touching any other session. `user_abort` and
   * `hard_timeout` survive so extra/wake/resume cannot restart a stopped
   * drain; a new user `SessionV2.prompt` clears them. Other terminal reasons
   * are cleared so a post-fail drain can pick up steers.
   * Idempotent if no bundle exists yet.
   */
  readonly resetForDrain: (sessionID: string) => Effect.Effect<void>
  /**
   * Releases the bundle for `sessionID`. Idempotent — a second release for an
   * already-released or never-created session is a no-op.
   */
  readonly release: (sessionID: string) => Effect.Effect<void>
}

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()(
  "SessionRuntime.SessionNotFound",
  { sessionID: Schema.String },
) {
  override get message() {
    return `SessionRuntime: no instance for session ${this.sessionID}`
  }
}

export const Service = Context.Service<Interface>("@opencode/SessionRuntime")

type Registry = ReadonlyMap<string, Instance>

const emptyRegistry: Registry = new Map()

/**
 * Build one per-session `Instance` from the existing `make` effects in
 * dependency order. Constructed without LLMClient — the bundle is
 * location-independent so it can live in the global registry.
 *
 * Order: worker/event/terminal/budget/retry/goal, then verifier channel wired
 * to the session event bus, then timer daemon (worker/event/terminal), then
 * context engine (budget).
 */
const makeInstance = (sessionID: string): Effect.Effect<Instance> =>
  Effect.gen(function* () {
    const workerState = yield* WorkerState.make
    const eventBus = yield* EventBus.make
    const terminal = yield* TerminalController.make
    // Cap is parent default; child sessions call budget.setCap(defaultChildCap) at drain start.
    const budget = yield* IterationBudget.make(IterationBudget.defaultParentCap)
    const retry = yield* TurnRetryState.make
    const goalStore = yield* GoalStore.make
    // Production breaker is armed: /loop breaker and Open-state shouldContinue
    // actually stop the drain. Tests that want a no-op construct CircuitBreaker.make()
    // without { enabled: true }.
    const circuitBreaker = yield* CircuitBreaker.make(5, { enabled: true })
    const treeBudget = yield* TreeBudget.make()

    const verifierBiDirectional = yield* VerifierBiDirectional.make.pipe(
      Effect.provideService(EventBus.Service, eventBus),
    )
    const timerDaemon = yield* TimerDaemon.make.pipe(
      Effect.provideService(WorkerState.Service, workerState),
      Effect.provideService(EventBus.Service, eventBus),
      Effect.provideService(TerminalController.Service, terminal),
    )
    const contextEngine = yield* ContextEngine.make.pipe(
      Effect.provideService(IterationBudget.Service, budget),
    )

    return {
      sessionID,
      workerState,
      eventBus,
      terminal,
      budget,
      retry,
      goalStore,
      verifierBiDirectional,
      timerDaemon,
      contextEngine,
      circuitBreaker,
      treeBudget,
      spawnEdges: new Map(),
      agentGuards: new Map(),
    }
  })

const resetInstance = (instance: Instance): Effect.Effect<void> =>
  Effect.gen(function* () {
    const snap = yield* instance.terminal.snapshot
    // User abort and the 24h ceiling must survive extra/wake/resume. Provider
    // unrecoverable_failure is cleared so a post-fail drain can pick up steers.
    if (snap.reason !== "user_abort" && snap.reason !== "hard_timeout") {
      yield* instance.terminal.reset
    }
    yield* instance.budget.reset()
    yield* instance.retry.reset
    yield* instance.circuitBreaker.reset
    // Force-set Active; intentional drain reset, not a guarded transition.
    yield* instance.workerState.reset
    // Deliberately NOT reset: timer pause/goal outlive a drain across the same
    // session bundle (pause state, configured goal) — only mutable run state
    // that a fresh drain must start clean is cleared above.
  })

export const make: Effect.Effect<Interface> = Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make<Registry>(emptyRegistry)

  const getOrCreate: Interface["getOrCreate"] = (sessionID) =>
    SynchronizedRef.modifyEffect(ref, (registry) =>
      Effect.gen(function* () {
        const existing = registry.get(sessionID)
        if (existing !== undefined) return [existing, registry] as const
        const instance = yield* makeInstance(sessionID)
        const next = new Map(registry).set(sessionID, instance)
        return [instance, next] as const
      }))

  const current: Interface["current"] = (sessionID) =>
    Effect.gen(function* () {
      const registry = yield* SynchronizedRef.get(ref)
      const instance = registry.get(sessionID)
      if (instance === undefined) return yield* Effect.fail(new SessionNotFound({ sessionID }))
      return instance
    })

  const resetForDrain: Interface["resetForDrain"] = (sessionID) =>
    SynchronizedRef.modifyEffect(ref, (registry) =>
      Effect.gen(function* () {
        const instance = registry.get(sessionID)
        if (instance === undefined) return [undefined, registry] as const
        yield* resetInstance(instance)
        return [undefined, registry] as const
      }),
    )

  // `release` is an explicit session-lifecycle operation. It drops the bundle
  // from the registry but does NOT interrupt TimerDaemon fibers: those belong
  // to the drain Scope that started them, whose finalizers own timer and hook
  // cleanup. The runner intentionally retains a session bundle across drains
  // until its owning session lifecycle calls release.
  const release: Interface["release"] = (sessionID) =>
    SynchronizedRef.update(ref, (registry) => {
      if (!registry.has(sessionID)) return registry
      const next = new Map(registry)
      next.delete(sessionID)
      return next
    })

  return { getOrCreate, current, resetForDrain, release }
})

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: layerForTest, deps: [] })
