// Map leftover plugin `tool.execute.*` hooks onto the unique Hooks bus.
// Fail-closed: timeout or throw on PreToolUse is Deny (same as file hooks).
import { Effect } from "effect"
import type { Hooks } from "@opencode-ai/plugin"
import type { InProcessHandler } from "@opencode-ai/core/hooks"

export const PLUGIN_HOOK_TIMEOUT_MS = 30_000

function raceTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function inProcessFromPlugin(plugin: Hooks, index: number): InProcessHandler[] {
  const handlers: InProcessHandler[] = []
  const before = plugin["tool.execute.before"]
  if (before) {
    const hookId = `plugin:${index}:PreToolUse`
    handlers.push({
      id: hookId,
      event: "PreToolUse",
      run: (envelope) =>
        Effect.promise(async () => {
          try {
            await raceTimeout(
              Promise.resolve(
                before(
                  { tool: envelope.toolName ?? "", sessionID: envelope.sessionId, callID: "" },
                  { args: envelope.toolInput },
                ),
              ),
              PLUGIN_HOOK_TIMEOUT_MS,
            )
            return { _tag: "Allow" as const }
          } catch {
            return { _tag: "Deny" as const, reason: "hook_failed", hookId }
          }
        }),
    })
  }

  const after = plugin["tool.execute.after"]
  if (after) {
    const hookId = `plugin:${index}:PostToolUse`
    handlers.push({
      id: hookId,
      event: "PostToolUse",
      run: (envelope) =>
        Effect.promise(async () => {
          try {
            await raceTimeout(
              Promise.resolve(
                after(
                  {
                    tool: envelope.toolName ?? "",
                    sessionID: envelope.sessionId,
                    callID: "",
                    args: envelope.toolInput,
                  },
                  { title: "", output: "", metadata: {} },
                ),
              ),
              PLUGIN_HOOK_TIMEOUT_MS,
            )
            return { _tag: "Allow" as const }
          } catch {
            return { _tag: "Deny" as const, reason: "hook_failed", hookId }
          }
        }),
    })
  }

  return handlers
}
