export * as SessionStore from "./store"

import { eq } from "drizzle-orm"
import { DateTime } from "effect"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionHistory } from "./history"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable, SessionTable } from "./sql"
import { fromRow } from "./info"
import { PermissionV1 } from "@opencode-ai/schema/permission-v1"

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined>
  readonly sessionPermission: (sessionID: SessionSchema.ID) => Effect.Effect<PermissionV1.Ruleset | undefined>
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly runnerContext: (
    sessionID: SessionSchema.ID,
    baselineSeq: number,
  ) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly message: SessionMessage.Message } | undefined>
  readonly wait: (
    sessionID: SessionSchema.ID,
    timeoutMs?: number,
    after?: number,
  ) => Effect.Effect<SessionMessage.Message[] | undefined, MessageDecodeError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)

    return Service.of({
      get: Effect.fn("SessionStore.get")(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
      sessionPermission: Effect.fn("SessionStore.sessionPermission")(function* (sessionID) {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        return row?.permission ?? undefined
      }),
      context: Effect.fn("SessionStore.context")(function* (sessionID) {
        return yield* SessionHistory.load(db, sessionID)
      }),
      runnerContext: Effect.fn("SessionStore.runnerContext")(function* (sessionID, baselineSeq) {
        return yield* SessionHistory.loadForRunner(db, sessionID, baselineSeq)
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        return row
          ? {
              sessionID: SessionSchema.ID.make(row.session_id),
              message: yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
            }
          : undefined
      }),
      wait: Effect.fn("SessionStore.wait")(function* (sessionID, timeoutMs = 30 * 60 * 1_000, after?: number) {
        // Single owner of "wait for the session to settle": the task host,
        // github handler, and SessionV2.wait all poll through this method
        // instead of each reimplementing a message loop. Returns undefined on
        // timeout so callers can distinguish "settled" from "budget expired".
        // `after` (epoch ms) ignores assistants settled before it — resume
        // paths pass the admit timestamp so a prior completed turn is skipped.
        const POLL_INTERVAL_MS = 500
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const msgs = yield* SessionHistory.load(db, sessionID)
          // A turn settles only when the LAST assistant message has completed:
          // an assistant whose turn ended in tool calls ("tool-calls" finish)
          // is mid-work, and settling on it would report "no text output" for
          // a subagent that is still executing tools.
          const lastAssistant = msgs.findLast((m) => m.type === "assistant")
          yield* Effect.logInfo("SessionStore.wait poll", {
            sessionID: String(sessionID),
            msgs: msgs.length,
            lastAssistant: lastAssistant?.type === "assistant" ? lastAssistant.finish ?? "no-finish" : "none",
          }).pipe(Effect.ignore)
          if (
            lastAssistant?.type === "assistant" &&
            lastAssistant.time.completed !== undefined &&
            // "tool-calls" means the turn ended by requesting tools — the
            // session continues working; only a terminal finish settles.
            lastAssistant.finish !== "tool-calls" &&
            (after === undefined || DateTime.toEpochMillis(lastAssistant.time.created) >= after)
          ) {
            return msgs
          }
          yield* Effect.sleep(`${POLL_INTERVAL_MS} millis`)
        }
        return undefined
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
