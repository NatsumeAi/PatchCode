import { expect, test } from "bun:test"
import { Effect } from "effect"
import { EventBus } from "../../src/session/loop-control/event-bus"
import { EventBridge } from "../../src/session/loop-control/event-bridge"

test("publishSubagentTerminal completed", async () => {
  await Effect.gen(function* () {
    const bus = yield* EventBus.make
    const seen: string[] = []
    yield* bus.subscribe((e) =>
      Effect.sync(() => {
        seen.push(e._tag)
      }),
    )
    yield* EventBridge.publishSubagentTerminal({
      eventBus: bus,
      parentSessionID: "p1",
      childSessionID: "c1",
      ok: true,
    })
    expect(seen).toContain("SubagentCompleted")
  }).pipe(Effect.runPromise)
})

test("publishSubagentTerminal failed", async () => {
  await Effect.gen(function* () {
    const bus = yield* EventBus.make
    const seen: string[] = []
    yield* bus.subscribe((e) =>
      Effect.sync(() => {
        if (e._tag === "SubagentFailed") seen.push(e.error)
      }),
    )
    yield* EventBridge.publishSubagentTerminal({
      eventBus: bus,
      parentSessionID: "p1",
      childSessionID: "c1",
      ok: false,
      error: "boom",
    })
    expect(seen).toContain("boom")
  }).pipe(Effect.runPromise)
})
