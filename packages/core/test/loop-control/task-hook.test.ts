import { describe, test, expect } from "bun:test"
import { Effect, Layer, Scope, Duration, Exit } from "effect"
import { EventBus } from "../../src/session/loop-control/event-bus"
import { TaskHook } from "../../src/session/loop-control/task-hook"

const layer = Layer.provide(TaskHook.layerForTest, EventBus.layerForTest).pipe(
  Layer.merge(EventBus.layerForTest),
)

describe("TaskHook — §8e-1 fire-and-forget fix", () => {
  test("subagent completion publishes SubagentCompleted even after tool scope closes", () =>
    Effect.gen(function* () {
      const sessionScope = yield* Scope.make()
      const completed: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "SubagentCompleted") completed.push(e.childSessionID)
        }),
      )

      // Fork the child into the sessionScope (not the tool scope).
      // The tool call returns immediately; the child is still running.
      yield* TaskHook.injectAfterSubagentForks(sessionScope, "parent-1", "child-1", () => Effect.sleep(Duration.millis(50)))

      // Tool scope closes here (simulated by just continuing — the sessionScope is still open).
      // Wait long enough for the child to finish.
      yield* Effect.sleep(Duration.millis(100))
      yield* Scope.close(sessionScope, Exit.void)

      expect(completed).toEqual(["child-1"])
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("child does NOT complete when sessionScope closes before child finishes", () =>
    Effect.gen(function* () {
      const sessionScope = yield* Scope.make()
      const completed: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "SubagentCompleted") completed.push(e.childSessionID)
        }),
      )

      yield* TaskHook.injectAfterSubagentForks(sessionScope, "parent-1", "child-2", () => Effect.sleep(Duration.millis(200)))
      // Close sessionScope early — child is interrupted, never publishes
      yield* Effect.sleep(Duration.millis(10))
      yield* Scope.close(sessionScope, Exit.void)
      yield* Effect.sleep(Duration.millis(250))

      expect(completed).toEqual([])
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("multiple children forked into the same sessionScope all publish on completion", () =>
    Effect.gen(function* () {
      const sessionScope = yield* Scope.make()
      const completed: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "SubagentCompleted") completed.push(e.childSessionID)
        }),
      )

      yield* TaskHook.injectAfterSubagentForks(sessionScope, "parent-1", "a", () => Effect.sleep(Duration.millis(30)))
      yield* TaskHook.injectAfterSubagentForks(sessionScope, "parent-1", "b", () => Effect.sleep(Duration.millis(60)))
      yield* TaskHook.injectAfterSubagentForks(sessionScope, "parent-1", "c", () => Effect.sleep(Duration.millis(90)))

      yield* Effect.sleep(Duration.millis(150))
      yield* Scope.close(sessionScope, Exit.void)

      expect(completed.sort()).toEqual(["a", "b", "c"])
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("child effect failure does NOT crash the harness (typed error absorbed)", () =>
    Effect.gen(function* () {
      const sessionScope = yield* Scope.make()
      const completed: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "SubagentCompleted") completed.push(e.childSessionID)
        }),
      )

      yield* TaskHook.injectAfterSubagentForks(sessionScope, "parent-1", "fail-child", () =>
        Effect.fail(new Error("child exploded")),
      )
      yield* Effect.sleep(Duration.millis(50))
      yield* Scope.close(sessionScope, Exit.void)

      expect(completed).toEqual([])
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )

  test("completion carries the owning parent session", () =>
    Effect.gen(function* () {
      const sessionScope = yield* Scope.make()
      const owners: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag !== "SubagentCompleted") return
          owners.push(e.parentSessionID)
        }),
      )

      yield* TaskHook.injectAfterSubagentForks(sessionScope, "parent-owned", "child-owned", () => Effect.void)
      yield* Effect.sleep(Duration.millis(20))
      yield* Scope.close(sessionScope, Exit.void)

      expect(owners).toEqual(["parent-owned"])
    }).pipe(Effect.provide(layer), Effect.runPromise),
  )
})
