export * as CompactionCheckpoint from "./compaction-checkpoint"

import { and, desc, eq, gt, gte } from "drizzle-orm"
import { Effect, Option } from "effect"
import { Database } from "../database/database"
import { Identifier } from "../id/id"
import { SessionContextEpoch } from "./context-epoch"
import { PromptTapeStore } from "./runner/prompt-tape-store"
import { SessionSchema } from "./schema"
import { CompactionCheckpointTable, MessageTable, SessionMessageTable } from "./sql"

const KEEP = 3

type MessageRow = typeof SessionMessageTable.$inferSelect

type MessageSnapshot = {
  readonly ids: readonly string[]
  readonly maxSeq: number
  readonly messages: readonly MessageRow[]
}

const parseMessageSnapshot = (raw: string): MessageSnapshot => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return { ids: parsed.filter((id): id is string => typeof id === "string"), maxSeq: 0, messages: [] }
    }
    if (!parsed || typeof parsed !== "object") return { ids: [], maxSeq: 0, messages: [] }
    const record = parsed as { ids?: unknown; maxSeq?: unknown; messages?: unknown }
    const ids = Array.isArray(record.ids) ? record.ids.filter((id): id is string => typeof id === "string") : []
    const maxSeq = typeof record.maxSeq === "number" ? record.maxSeq : 0
    const messages = Array.isArray(record.messages) ? (record.messages as MessageRow[]) : []
    return { ids, maxSeq, messages }
  } catch {
    return { ids: [], maxSeq: 0, messages: [] }
  }
}

export const write = (input: {
  readonly sessionID: string
  readonly tapeJson: string
  readonly messageIdsJson?: string
}) =>
  Effect.gen(function* () {
    const dbOpt = yield* Effect.serviceOption(Database.Service)
    if (Option.isNone(dbOpt)) return undefined
    const db = dbOpt.value.db
    const sessionID = SessionSchema.ID.make(input.sessionID)
    const messageRows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    const fallback = input.messageIdsJson ? parseMessageSnapshot(input.messageIdsJson) : { ids: [] as string[] }
    const payload: MessageSnapshot = {
      ids: messageRows.length > 0 ? messageRows.map((row) => String(row.id)) : fallback.ids,
      maxSeq: messageRows.reduce((max, row) => Math.max(max, row.seq), 0),
      messages: messageRows,
    }
    const id = Identifier.create("chk", "ascending")
    const createdAt = Date.now()
    yield* db
      .insert(CompactionCheckpointTable)
      .values({
        id,
        session_id: sessionID,
        created_at: createdAt,
        tape_json: input.tapeJson,
        message_ids_json: JSON.stringify(payload),
      })
      .run()
      .pipe(Effect.orDie, Effect.ignore)
    const rows = yield* db
      .select({ id: CompactionCheckpointTable.id })
      .from(CompactionCheckpointTable)
      .where(eq(CompactionCheckpointTable.session_id, sessionID))
      .orderBy(desc(CompactionCheckpointTable.created_at))
      .all()
      .pipe(Effect.orDie)
    const extra = rows.slice(KEEP)
    for (const row of extra) {
      yield* db
        .delete(CompactionCheckpointTable)
        .where(eq(CompactionCheckpointTable.id, row.id))
        .run()
        .pipe(Effect.orDie, Effect.ignore)
    }
    return id
  })

export const latest = (sessionID: string) =>
  Effect.gen(function* () {
    const dbOpt = yield* Effect.serviceOption(Database.Service)
    if (Option.isNone(dbOpt)) return undefined
    return yield* dbOpt.value.db
      .select()
      .from(CompactionCheckpointTable)
      .where(eq(CompactionCheckpointTable.session_id, SessionSchema.ID.make(sessionID)))
      .orderBy(desc(CompactionCheckpointTable.created_at))
      .get()
      .pipe(Effect.orDie)
  })

export const snapshot = (sessionID: string) =>
  PromptTapeStore.epochs(sessionID).map((epoch) => ({
    baselineSeq: epoch.baselineSeq,
    tape: epoch.tape,
    lastSeq: PromptTapeStore.getLastSeq(sessionID, epoch.baselineSeq),
    messageSeqs: PromptTapeStore.getMessageSeqs(sessionID, epoch.baselineSeq),
    recall: PromptTapeStore.getRecall(sessionID, epoch.baselineSeq) ?? "",
  }))

const restoreMessages = (sessionID: string, payload: MessageSnapshot) =>
  Effect.gen(function* () {
    const dbOpt = yield* Effect.serviceOption(Database.Service)
    if (Option.isNone(dbOpt)) return
    const db = dbOpt.value.db
    const sid = SessionSchema.ID.make(sessionID)
    const extra = yield* db
      .select({ id: SessionMessageTable.id })
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, sid),
          eq(SessionMessageTable.type, "compaction"),
          gt(SessionMessageTable.seq, payload.maxSeq),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    for (const row of extra) {
      yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, row.id)).run().pipe(Effect.orDie, Effect.ignore)
      yield* db
        .delete(MessageTable)
        .where(eq(MessageTable.id, String(row.id) as (typeof MessageTable.$inferSelect)["id"]))
        .run()
        .pipe(Effect.orDie, Effect.ignore)
    }
    for (const message of payload.messages) {
      yield* db
        .insert(SessionMessageTable)
        .values(message)
        .onConflictDoUpdate({
          target: SessionMessageTable.id,
          set: {
            type: message.type,
            seq: message.seq,
            time_created: message.time_created,
            data: message.data,
          },
        })
        .run()
        .pipe(Effect.orDie, Effect.ignore)
    }
  })

const persistRestoredTape = (sessionID: string) =>
  Effect.gen(function* () {
    const dbOpt = yield* Effect.serviceOption(Database.Service)
    if (Option.isNone(dbOpt)) return
    const epochs = snapshot(sessionID)
    const last = epochs.at(-1)
    if (!last) return
    yield* SessionContextEpoch.saveTape(dbOpt.value.db, SessionSchema.ID.make(sessionID), {
      tape: last.tape as never,
      lastSeq: last.lastSeq,
      messageSeqs: last.messageSeqs,
      recall: last.recall,
      baselineSeq: last.baselineSeq,
    }).pipe(Effect.ignore)
  })

/** Restore tape + messages from a checkpoint. Does not call Session.prompt. */
export const restore = (sessionID: string, checkpointID?: string) =>
  Effect.gen(function* () {
    const dbOpt = yield* Effect.serviceOption(Database.Service)
    if (Option.isNone(dbOpt)) return false
    const db = dbOpt.value.db
    const row = checkpointID
      ? yield* db
          .select()
          .from(CompactionCheckpointTable)
          .where(eq(CompactionCheckpointTable.id, checkpointID))
          .get()
          .pipe(Effect.orDie)
      : yield* latest(sessionID)
    if (!row || String(row.session_id) !== String(sessionID)) return false
    let parsed: ReturnType<typeof snapshot>
    try {
      parsed = JSON.parse(row.tape_json) as ReturnType<typeof snapshot>
    } catch {
      return false
    }
    if (!Array.isArray(parsed)) return false
    PromptTapeStore.clear(sessionID)
    for (const epoch of parsed) {
      if (!epoch || typeof epoch.baselineSeq !== "number" || !epoch.tape) continue
      PromptTapeStore.set(sessionID, epoch.baselineSeq, epoch.tape as never)
      if (typeof epoch.lastSeq === "number") PromptTapeStore.setLastSeq(sessionID, epoch.baselineSeq, epoch.lastSeq)
      if (Array.isArray(epoch.messageSeqs)) PromptTapeStore.setMessageSeqs(sessionID, epoch.baselineSeq, epoch.messageSeqs)
      if (typeof epoch.recall === "string") PromptTapeStore.setRecall(sessionID, epoch.baselineSeq, epoch.recall)
    }
    yield* restoreMessages(sessionID, parseMessageSnapshot(row.message_ids_json))
    yield* persistRestoredTape(sessionID)
    yield* db
      .delete(CompactionCheckpointTable)
      .where(
        and(
          eq(CompactionCheckpointTable.session_id, SessionSchema.ID.make(sessionID)),
          gte(CompactionCheckpointTable.created_at, row.created_at),
        ),
      )
      .run()
      .pipe(Effect.orDie, Effect.ignore)
    return true
  })

export const restoreTape = restore
