import { Effect } from "effect"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"

export const loopHistoryCommand = (_raw: string) =>
  Effect.gen(function* () {
    const events = yield* EventBus.snapshotBuffer(20)
    if (events.length === 0) return "no loop events recorded"
    return events
      .map((e) => (e._tag === "HeartbeatTick" ? `${e._tag}(${e.time})` : e._tag))
      .join("\n")
  })
