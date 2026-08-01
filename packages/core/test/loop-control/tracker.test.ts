import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { WorkerState } from "../../src/session/loop-control/worker-state"
import { EventBus } from "../../src/session/loop-control/event-bus"
import { LoopControlTracker } from "../../src/session/loop-control/tracker"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LoopControlTracker.layerForTest.pipe(
    Layer.provideMerge(EventBus.layerForTest),
    Layer.provideMerge(WorkerState.layerForTest),
  ),
)

describe("LoopControlTracker", () => {
  it.effect("starts Idle", () =>
    Effect.gen(function* () {
      expect(yield* LoopControlTracker.state).toBe("Idle")
    }),
  )

  it.effect("set to Running", () =>
    Effect.gen(function* () {
      yield* LoopControlTracker.set("Running")
      expect(yield* LoopControlTracker.state).toBe("Running")
    }),
  )

  it.effect("Running to Waiting", () =>
    Effect.gen(function* () {
      yield* LoopControlTracker.set("Running")
      yield* LoopControlTracker.set("Waiting")
      expect(yield* LoopControlTracker.state).toBe("Waiting")
    }),
  )

  it.effect("Waiting to Paused", () =>
    Effect.gen(function* () {
      yield* LoopControlTracker.set("Waiting")
      yield* LoopControlTracker.set("Paused")
      expect(yield* LoopControlTracker.state).toBe("Paused")
    }),
  )

  it.effect("Paused to HardStopped", () =>
    Effect.gen(function* () {
      yield* LoopControlTracker.set("Paused")
      yield* LoopControlTracker.set("HardStopped")
      expect(yield* LoopControlTracker.state).toBe("HardStopped")
    }),
  )

  it.effect("HardStopped back to Idle restarts the loop", () =>
    Effect.gen(function* () {
      yield* LoopControlTracker.set("HardStopped")
      yield* LoopControlTracker.set("Idle")
      expect(yield* LoopControlTracker.state).toBe("Idle")
    }),
  )
})
