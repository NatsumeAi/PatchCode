import { Effect } from "effect"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"

export const loopVerifierCommand = (_raw: string) =>
  Effect.gen(function* () {
    const events = yield* EventBus.snapshotBuffer(50)
    const rejects = events.filter((e) => e._tag === "VerifierRejectInjected")
    const completions = events.filter((e) => e._tag === "SubagentCompleted")
    if (rejects.length === 0 && completions.length === 0) {
      return "verifier: Fresh (no audits yet)"
    }
    return [
      `verifier: ${rejects.length > 0 ? "Reused" : "Fresh"} (reject count: ${rejects.length})`,
      ...(rejects.length ? [`last reject: ${rejects.at(-1)!.reason}`] : []),
      `subagent completions: ${completions.length}`,
    ].join("\n")
  })
