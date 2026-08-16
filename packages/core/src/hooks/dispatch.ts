export * as HooksDispatch from "./dispatch"

import { Effect } from "effect"
import { runCommand } from "./run-command"
import { runHttp } from "./run-http"
import {
  BLOCKING,
  matchesTool,
  type Decision,
  type Envelope,
  type EventName,
  type LoadedSpec,
} from "./schema"

export type InProcessHandler = {
  readonly id: string
  readonly event: EventName
  readonly matcher?: string
  readonly run: (envelope: Envelope) => Effect.Effect<Decision>
}

export type DispatchInput = {
  readonly event: EventName
  readonly sessionID: string
  readonly cwd: string
  readonly toolName?: string
  readonly toolInput?: unknown
  readonly specs: readonly LoadedSpec[]
  readonly handlers: readonly InProcessHandler[]
  readonly sessionIDForWrap?: string
}

const truncate = (value: unknown) => {
  const json = JSON.stringify(value ?? null) ?? "null"
  if (json.length <= 128 * 1024) return { toolInput: value, toolInputTruncated: false as const }
  return { toolInput: json.slice(0, 128 * 1024), toolInputTruncated: true as const }
}

export const dispatch = (input: DispatchInput): Effect.Effect<Decision> =>
  Effect.gen(function* () {
    const truncated = truncate(input.toolInput)
    const envelope: Envelope = {
      hookEventName: input.event,
      sessionId: input.sessionID,
      cwd: input.cwd,
      toolName: input.toolName,
      ...truncated,
      timestamp: new Date().toISOString(),
    }
    const blocking = BLOCKING.has(input.event)

    for (const spec of input.specs) {
      for (const group of spec.events[input.event] ?? []) {
        if (input.toolName && !matchesTool(group.matcher, input.toolName)) continue
        if (!input.toolName && group.matcher.trim() && input.event === "PreToolUse") continue
        for (const [index, hook] of group.hooks.entries()) {
          const hookId = `${spec.id}:${input.event}:${index}`
          const decision =
            hook.type === "command"
              ? yield* Effect.tryPromise({
                  try: () =>
                    runCommand({
                      hook,
                      envelope,
                      origin: spec.origin,
                      cwd: input.cwd,
                      hookId,
                      sessionID: input.sessionIDForWrap,
                    }),
                  catch: () => ({ _tag: "Deny" as const, reason: "hook_failed", hookId }),
                })
              : yield* Effect.tryPromise({
                  try: () => runHttp({ hook, envelope, origin: spec.origin, hookId }),
                  catch: () => ({ _tag: "Deny" as const, reason: "hook_failed", hookId }),
                })
          if (decision._tag === "Deny") {
            if (blocking) return decision
          }
        }
      }
    }

    for (const handler of input.handlers) {
      if (handler.event !== input.event) continue
      if (input.toolName && handler.matcher && !matchesTool(handler.matcher, input.toolName)) continue
      const decision = yield* handler.run(envelope).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            blocking
              ? ({ _tag: "Deny" as const, reason: "hook_failed", hookId: handler.id } satisfies Decision)
              : ({ _tag: "Allow" as const } satisfies Decision),
          ),
        ),
      )
      if (decision._tag === "Deny" && blocking) return decision
    }

    return { _tag: "Allow" }
  })
