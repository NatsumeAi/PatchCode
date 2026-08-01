import { Effect, Option } from "effect"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"

export const loopFailoverCommand = (_raw: string) =>
  Effect.gen(function* () {
    const maybeBus = yield* Effect.serviceOption(EventBus.Service)
    if (Option.isNone(maybeBus)) {
      return "failover: loop-control bus unavailable"
    }
    const events = yield* maybeBus.value.snapshotBuffer(50)
    const hard = events.filter((e) => e._tag === "HardAbort")
    const lost = events.filter((e) => e._tag === "SubagentHeartbeatLost")
    if (hard.length === 0 && lost.length === 0) {
      return "failover: no retries recorded"
    }
    return [
      ...(hard.length ? [`hard aborts: ${hard.length} (last: ${hard.at(-1)!.reason})`] : []),
      ...(lost.length ? [`subagent heartbeat losses: ${lost.length}`] : []),
      "failover reason classes: rate_limit / server_unavailable / timeout / context_overflow / unknown",
    ].join("\n")
  })
