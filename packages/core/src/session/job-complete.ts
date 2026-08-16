export * as JobComplete from "./job-complete"

import { Effect, Option } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import type { BackgroundJob } from "../background-job"
import { SessionV2 } from "../session"
import { SessionExecution } from "./execution"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionRuntime } from "./runtime"
import { SessionSchema } from "./schema"
import { ToolOutputStore } from "../tool-output-store"

const MAX_RESULT_CHARS = ToolOutputStore.MAX_BYTES

export const formatJobResult = (info: BackgroundJob.Info) => {
  const status = info.status
  const exit = info.metadata?.exit
  const exitAttr = typeof exit === "number" ? ` exit="${exit}"` : ""
  const raw = info.output ?? ""
  const bounded = raw.length > MAX_RESULT_CHARS ? raw.slice(-MAX_RESULT_CHARS) : raw
  return `<job-result jobID="${info.id}" status="${status}"${exitAttr}>\n${bounded}\n</job-result>`
}

const ownerSessionID = (info: BackgroundJob.Info): SessionSchema.ID | undefined => {
  const meta = info.metadata
  const id = meta?.sessionId ?? meta?.sessionID
  if (typeof id !== "string" || id.length === 0) return undefined
  return SessionSchema.ID.make(id)
}

/**
 * Admit a synthetic job-result into the parent session without waking an
 * aborted drain. Always pass `resume: false` — omitting it defaults true and
 * `terminal.reset`s `/loop abort`.
 */
export const notifyJobFinished = (info: BackgroundJob.Info): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (info.type !== "bash") return
    const sessionID = ownerSessionID(info)
    if (!sessionID) return
    const text = formatJobResult(info)
    const prompt = Prompt.make({
      text,
      parts: [{ type: "text", text, synthetic: true }],
    })

    const session = yield* Effect.serviceOption(SessionV2.Service)
    if (Option.isSome(session)) {
      yield* session.value
        .prompt({
          sessionID,
          prompt,
          resume: false,
        })
        .pipe(Effect.ignore)
    } else {
      const database = yield* Effect.serviceOption(Database.Service)
      const events = yield* Effect.serviceOption(EventV2.Service)
      if (Option.isSome(database) && Option.isSome(events)) {
        yield* SessionInput.admit(database.value.db, events.value, {
          id: SessionMessage.ID.create(),
          sessionID,
          prompt,
          delivery: "steer",
        }).pipe(Effect.ignore)
      }
    }

    const runtime = yield* Effect.serviceOption(SessionRuntime.Service)
    if (Option.isSome(runtime)) {
      const inst = yield* runtime.value.getOrCreate(sessionID)
      const snap = yield* inst.terminal.snapshot
      // user_abort and hard_timeout survive extra/wake/resume; job completion
      // must not restart a stopped drain (freeze: no terminal.reset, no wake).
      if (snap.reason === "user_abort" || snap.reason === "hard_timeout") return
    }

    const execution = yield* Effect.serviceOption(SessionExecution.Service)
    if (Option.isSome(execution)) {
      yield* execution.value.wake(sessionID).pipe(Effect.ignore)
    }
  }).pipe(Effect.ignore)
