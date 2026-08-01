export * as TaskHook from "./task-hook"

import { Context, Effect, Layer, Scope } from "effect"
import { EventBus } from "./event-bus"

/**
 * §8e-1 fix — subagent inject fire-and-forget (Plan 3 Task 4).
 *
 * Problem (docs/loop-design.md §8e 问题 1): `packages/opencode/src/tool/task.ts`
 * originally forked the subagent worker via `Effect.fork` into the tool call's
 * own scope. Tool scope closes when the tool returns, killing the child
 * before it finishes — completion events were silently dropped.
 *
 * Fix: `injectAfterSubagentForks(sessionScope, parentSessionID, childSessionID, runChildEffect)`
 * forks the child into the SESSION-level scope (not the tool scope). Child
 * survives tool return; on completion it publishes `SubagentCompleted` on the
 * loop-control EventBus so the harness can transition the worker
 * Waiting → Active.
 *
 * Per AGENTS.md: "Use `Effect.forkIn(scope)` not `Effect.fork`".
 *
 * Note: the child's typed errors are caught and swallowed (sandboxed) — a
 * child failure must NOT crash the parent harness. The harness observes
 * child completion/failure through owner-scoped events.
 */

export interface Interface {
  readonly injectAfterSubagentForks: (
    sessionScope: Scope.Scope,
    parentSessionID: string,
    childSessionID: string,
    runChildEffect: () => Effect.Effect<void, unknown>,
  ) => Effect.Effect<void, never, EventBus.Interface>
}

export const Service = Context.Service<Interface>("@opencode/LoopControl/TaskHook")

export const make: Effect.Effect<Interface> = Effect.gen(function* () {
  const injectAfterSubagentForks: Interface["injectAfterSubagentForks"] = (
    sessionScope,
    parentSessionID,
    childSessionID,
    runChildEffect,
  ) =>
    Effect.gen(function* () {
      const child = Effect.gen(function* () {
        const exit = yield* runChildEffect().pipe(Effect.exit)
        if (exit._tag === "Success") {
          yield* EventBus.publish({ _tag: "SubagentCompleted", parentSessionID, childSessionID })
          return
        }
        yield* EventBus.publish({
          _tag: "SubagentFailed",
          parentSessionID,
          childSessionID,
          error: String(exit.cause),
        })
      })
      yield* Effect.forkIn(child, sessionScope)
    })

  return { injectAfterSubagentForks }
})

export const injectAfterSubagentForks = (
  sessionScope: Scope.Scope,
  parentSessionID: string,
  childSessionID: string,
  runChildEffect: () => Effect.Effect<void, unknown>,
): Effect.Effect<void, never, Interface | EventBus.Interface> =>
  Effect.gen(function* () {
    const svc = yield* Service
    yield* svc.injectAfterSubagentForks(sessionScope, parentSessionID, childSessionID, runChildEffect)
  })

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make)
