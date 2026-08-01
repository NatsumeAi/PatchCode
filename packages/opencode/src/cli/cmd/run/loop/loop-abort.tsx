import { Effect } from "effect"
import { EventBus } from "@opencode-ai/core/session/loop-control/event-bus"
import { TerminalController } from "@opencode-ai/core/session/loop-control/terminal-controller"

export const loopAbortCommand = (_raw: string) =>
  Effect.gen(function* () {
    const at = yield* Effect.clockWith((c) => c.currentTimeMillis)
    yield* EventBus.publish({ _tag: "AbortRequested", source: "user-cli", at })
    yield* TerminalController.request("user_abort")
    return "abort requested; harness loop will break on next turn boundary"
  })
