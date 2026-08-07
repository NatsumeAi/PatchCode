export * as SiblingMessage from "./sibling-message"

import { Effect, Option } from "effect"
import { SubagentRegistry } from "./subagent-registry"
import { SessionSchema } from "./schema"
import { SessionInput } from "./input"
import { Prompt } from "./prompt"
import { SessionMessage } from "./message"
import { EventV2 } from "../event"
import { SessionExecution } from "./execution"
import type { Database } from "../database/database"

/**
 * Deliver a text message to a subagent (or parent) by registry address.
 * Address format: /root/<subagentType>/<childSessionID> (from host register).
 */
export const deliver = (input: {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly fromSessionID: SessionSchema.ID
  readonly toAddress: string
  readonly text: string
}): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const registryOpt = yield* Effect.serviceOption(SubagentRegistry.Service)
    if (Option.isNone(registryOpt)) {
      return yield* Effect.fail(new Error("SubagentRegistry unavailable for sibling message"))
    }
    const all = yield* registryOpt.value.snapshot
    const target = all.find((r) => r.address === input.toAddress || String(r.childSessionID) === input.toAddress)
    if (!target) {
      return yield* Effect.fail(new Error(`No subagent at address "${input.toAddress}"`))
    }
    const messageID = SessionMessage.ID.create()
    const body = [
      `<peer_message from="${input.fromSessionID}" to="${target.address}">`,
      input.text,
      `</peer_message>`,
    ].join("\n")
    yield* SessionInput.admit(input.db, input.events, {
      id: messageID,
      sessionID: target.childSessionID,
      prompt: Prompt.make({ text: body }),
      delivery: "steer",
    })
    const executionOpt = yield* Effect.serviceOption(SessionExecution.Service)
    if (Option.isSome(executionOpt)) {
      yield* executionOpt.value.wake(target.childSessionID).pipe(Effect.ignore)
    }
  })
