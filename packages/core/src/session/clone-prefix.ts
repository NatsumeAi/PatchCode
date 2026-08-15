import { and, asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Location } from "../location"
import { SessionV1 } from "../v1/session"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { MessageTable, PartTable, SessionMessageTable } from "./sql"

export function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]
    const num = parseInt(match[2], 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}

/** Copy V1 message/part rows and SessionMessageTable up to (exclusive) messageID onto a new session. Does not copy PromptTape. */
export const copyPrefix = Effect.fn("Session.copyPrefix")(function* (input: {
  db: Database.Interface["db"]
  events: EventV2.Interface
  from: SessionSchema.ID
  to: SessionSchema.ID
  messageID?: SessionMessage.ID
  location?: Location.Ref
}) {
  const options = input.location ? { location: input.location } : undefined
  const idMap = new Map<string, string>()

  const msgs = yield* input.db
    .select()
    .from(MessageTable)
    .where(eq(MessageTable.session_id, input.from))
    .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
    .all()
    .pipe(Effect.orDie)

  for (const row of msgs) {
    if (input.messageID && String(row.id) >= String(input.messageID)) break
    const newID = SessionMessage.ID.create()
    idMap.set(String(row.id), String(newID))
    const info = {
      ...row.data,
      id: SessionV1.MessageID.make(String(newID)),
      sessionID: input.to,
    } as SessionV1.Info
    if (info.role === "assistant" && info.parentID) {
      const mapped = idMap.get(String(info.parentID))
      if (mapped) info.parentID = SessionV1.MessageID.make(mapped)
    }
    yield* input.events.publish(SessionV1.Event.MessageUpdated, { sessionID: input.to, info }, options)

    const parts = yield* input.db
      .select()
      .from(PartTable)
      .where(and(eq(PartTable.message_id, row.id), eq(PartTable.session_id, input.from)))
      .orderBy(asc(PartTable.id))
      .all()
      .pipe(Effect.orDie)

    for (const part of parts) {
      const p = {
        ...part.data,
        id: SessionV1.PartID.ascending(),
        messageID: SessionV1.MessageID.make(String(newID)),
        sessionID: input.to,
      } as SessionV1.Part
      if (p.type === "compaction" && p.tail_start_id) {
        const mapped = idMap.get(String(p.tail_start_id))
        p.tail_start_id = mapped ? SessionV1.MessageID.make(mapped) : undefined
      }
      yield* input.events.publish(
        SessionV1.Event.PartUpdated,
        { sessionID: input.to, part: structuredClone(p), time: Date.now() },
        options,
      )
    }
  }

  const v2Rows = yield* input.db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, input.from))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)

  let seq = 0
  for (const row of v2Rows) {
    if (input.messageID && String(row.id) >= String(input.messageID)) break
    const mapped = idMap.get(String(row.id))
    const newID = mapped ? SessionMessage.ID.make(mapped) : SessionMessage.ID.create()
    if (!mapped) idMap.set(String(row.id), String(newID))
    yield* input.db
      .insert(SessionMessageTable)
      .values({
        id: newID,
        session_id: input.to,
        type: row.type,
        seq: seq++,
        time_created: row.time_created,
        data: row.data,
      })
      .run()
      .pipe(Effect.orDie)
  }
})
