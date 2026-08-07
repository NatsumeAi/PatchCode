export * as EventBridge from "./event-bridge"

import { Effect } from "effect"
import { EventBus } from "./event-bus"

/**
 * Publish subagent terminal events onto a parent session's loop-control EventBus.
 * Called from the V2 Task host choke point (notifyParent / foreground settle)
 * so LoopControlHost can transition WorkerState Waiting → Active (or abort on fail).
 */
export const publishSubagentTerminal = (input: {
  readonly eventBus: EventBus.Interface
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly ok: boolean
  readonly error?: string
}): Effect.Effect<void> =>
  input.ok
    ? input.eventBus.publish({
        _tag: "SubagentCompleted",
        parentSessionID: input.parentSessionID,
        childSessionID: input.childSessionID,
      })
    : input.eventBus.publish({
        _tag: "SubagentFailed",
        parentSessionID: input.parentSessionID,
        childSessionID: input.childSessionID,
        error: input.error ?? "failed",
      })
