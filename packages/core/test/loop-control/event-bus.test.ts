import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { EventBus } from "../../src/session/loop-control/event-bus"
import type { LoopControlEvent } from "../../src/session/loop-control/event-bus"

describe("EventBus", () => {
  it("publish + subscribe + 收 events", async () => {
    const program = Effect.gen(function* () {
      const received: LoopControlEvent[] = []
      const unsub = yield* EventBus.subscribe((e) =>
        Effect.sync(() => {
          received.push(e)
        }),
      )
      yield* EventBus.publish({ _tag: "HeartbeatTick", time: 0 })
      yield* EventBus.publish({ _tag: "StopReminder", reason: "x" })
      yield* unsub
      yield* EventBus.publish({ _tag: "LoopTerminated", reason: "y" })

      // shutdown dispatcher + drain any in-flight pubsub events
      yield* EventBus.shutdown

      expect(received).toHaveLength(2)
      expect(received[0]._tag).toBe("HeartbeatTick")
      expect(received[1]._tag).toBe("StopReminder")
    }).pipe(Effect.provide(EventBus.layerForTest))

    await Effect.runPromise(program)
  })

  it("multiple subscribers each receive a copy", async () => {
    const program = Effect.gen(function* () {
      const a: LoopControlEvent[] = []
      const b: LoopControlEvent[] = []
      const ua = yield* EventBus.subscribe((e) => Effect.sync(() => a.push(e)))
      const ub = yield* EventBus.subscribe((e) => Effect.sync(() => b.push(e)))

      yield* EventBus.publish({ _tag: "HardAbort", reason: "test" })
      yield* ua
      yield* ub
      yield* EventBus.shutdown

      expect(a).toHaveLength(1)
      expect(b).toHaveLength(1)
      expect(a[0]._tag).toBe("HardAbort")
      expect(b[0]._tag).toBe("HardAbort")
    }).pipe(Effect.provide(EventBus.layerForTest))

    await Effect.runPromise(program)
  })

  it("unsubscribe before publish means no receipt", async () => {
    const program = Effect.gen(function* () {
      const received: LoopControlEvent[] = []
      const unsub = yield* EventBus.subscribe((e) => Effect.sync(() => received.push(e)))
      yield* unsub
      yield* EventBus.publish({ _tag: "LoopTerminated", reason: "late" })
      yield* EventBus.shutdown

      // dispatcher drained after publish; no sub means no receipt
      expect(received).toHaveLength(0)
    }).pipe(Effect.provide(EventBus.layerForTest))

    await Effect.runPromise(program)
  })

  it("Null placeholder event publishes without error", async () => {
    const program = Effect.gen(function* () {
      const received: LoopControlEvent[] = []
      const unsub = yield* EventBus.subscribe((e) => Effect.sync(() => received.push(e)))
      yield* EventBus.publish({ _tag: "Null" })
      yield* unsub
      yield* EventBus.shutdown

      expect(received).toHaveLength(1)
      expect(received[0]._tag).toBe("Null")
    }).pipe(Effect.provide(EventBus.layerForTest))

    await Effect.runPromise(program)
  })

  it("publishes BackgroundJobDone + owner-scoped SubagentCompleted event shapes", async () => {
    const program = Effect.gen(function* () {
      const received: LoopControlEvent[] = []
      const unsub = yield* EventBus.subscribe((e) => Effect.sync(() => received.push(e)))
      yield* EventBus.publish({ _tag: "BackgroundJobDone", jobID: "job-1" })
      yield* EventBus.publish({ _tag: "SubagentCompleted", parentSessionID: "ses-parent", childSessionID: "ses-7" })
      yield* unsub
      yield* EventBus.shutdown

      expect(received).toHaveLength(2)
      expect(received[0]._tag).toBe("BackgroundJobDone")
      expect(received[1]._tag).toBe("SubagentCompleted")
    }).pipe(Effect.provide(EventBus.layerForTest))

    await Effect.runPromise(program)
  })
})
