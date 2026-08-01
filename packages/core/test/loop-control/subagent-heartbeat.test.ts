import { describe, expect } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { EventBus, type LoopControlEvent } from "../../src/session/loop-control/event-bus"
import { SubagentHeartbeat } from "../../src/session/loop-control/subagent-heartbeat"
import { testEffect } from "../lib/effect"

const layer = Layer.provide(SubagentHeartbeat.layerForTest, EventBus.layerForTest).pipe(
  Layer.merge(EventBus.layerForTest),
)

const it = testEffect(layer)

describe("SubagentHeartbeat — §8e-4 liveness probe", () => {
  it.effect("child daemon publishes SubagentHeartbeat every 30s; 2 beats after 65s", () =>
    Effect.gen(function* () {
      const beats: LoopControlEvent[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "SubagentHeartbeat") beats.push(e)
        }),
      )
      yield* SubagentHeartbeat.startForChild("child-1")
      yield* TestClock.adjust(Duration.seconds(65))
      yield* SubagentHeartbeat.stopForChild("child-1")
      expect(beats.length).toBeGreaterThanOrEqual(2)
    }),
  )

  it.effect("parent watcher fires SubagentHeartbeatLost after 60s without a beat", () =>
    Effect.gen(function* () {
      const lost: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "SubagentHeartbeatLost") lost.push(e.childSessionID)
        }),
      )
      // Only the watcher runs — no child daemon started, so no beats arrive.
      yield* SubagentHeartbeat.startWatcherForChild("child-1")
      yield* TestClock.adjust(Duration.seconds(66))
      expect(lost).toEqual(["child-1"])
    }),
  )

  it.effect("watcher does NOT fire Lost while beats keep arriving (child alive)", () =>
    Effect.gen(function* () {
      const lost: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "SubagentHeartbeatLost") lost.push(e.childSessionID)
        }),
      )
      yield* SubagentHeartbeat.startForChild("child-2")
      yield* SubagentHeartbeat.startWatcherForChild("child-2")
      yield* TestClock.adjust(Duration.seconds(125))
      yield* SubagentHeartbeat.stopForChild("child-2")
      expect(lost).toEqual([])
    }),
  )

  it.effect("watcher for a different child ignores other children's beats", () =>
    Effect.gen(function* () {
      const lost: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "SubagentHeartbeatLost") lost.push(e.childSessionID)
        }),
      )
      // child-2 beats every 30s; watcher only watches child-1 which never beats.
      yield* SubagentHeartbeat.startForChild("child-2")
      yield* SubagentHeartbeat.startWatcherForChild("child-1")
      yield* TestClock.adjust(Duration.seconds(125))
      yield* SubagentHeartbeat.stopForChild("child-2")
      expect(lost).toEqual(["child-1"])
    }),
  )

  it.effect("stopForChild stops the child daemon (no more beats after stop)", () =>
    Effect.gen(function* () {
      const beats: string[] = []
      yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          if (e._tag === "SubagentHeartbeat") beats.push(e.childSessionID)
        }),
      )
      yield* SubagentHeartbeat.startForChild("child-3")
      yield* TestClock.adjust(Duration.seconds(35))
      yield* SubagentHeartbeat.stopForChild("child-3")
      const before = beats.length
      yield* TestClock.adjust(Duration.seconds(65))
      expect(beats.length).toBe(before)
    }),
  )
})
