/**
 * Golden semantics for Instance HTTP → V2 revert adapter.
 *
 * Mapping (locked in docs/superpowers/specs/2026-08-07-dual-path-classification.md):
 *   session.revert   → SessionV2.revert.stage
 *   session.unrevert → SessionV2.revert.clear
 *   cleanup (prompt/shell/summarize) → SessionV2.revert.commit
 *
 * Busy check for Instance handlers: SessionV2.active / SessionExecution.active
 * (not SessionRunState).
 */
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { fromRow } from "@opencode-ai/core/session/info"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionRevert } from "@opencode-ai/core/session/revert"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])).pipe(
    Layer.provideMerge(Snapshot.noopLayer),
  ),
)

const sessionID = SessionV2.ID.make("ses_revert_adapter_golden")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (id: SessionMessage.ID, seq: number) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Assistant.make({
      id,
      type: "assistant",
      agent: "build",
      model,
      content: [],
      time: { created },
    }),
  )
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(created), data }
}

describe("revert V2 adapter golden (stage/clear/commit)", () => {
  it.effect("stage sets SessionTable.revert; clear clears; commit truncates tail", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "revert-adapter",
          directory: "/project",
          title: "revert-adapter",
          version: "test",
        })
        .run()
      const boundary = SessionMessage.ID.make("msg_boundary")
      const later = SessionMessage.ID.make("msg_later")
      yield* db.insert(SessionMessageTable).values([assistantRow(boundary, 1), assistantRow(later, 2)]).run()

      const events = yield* EventV2.Service
      const load = () =>
        db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => fromRow(row!)),
          )

      // Instance HTTP revert → stage (files:false skips restore map; Snapshot.noop for capture)
      yield* SessionRevert.stage({ session: yield* load(), messageID: boundary, files: false }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.provideService(EventV2.Service, events),
      )
      expect((yield* load()).revert?.messageID).toBe(boundary)

      // Instance HTTP unrevert → clear
      yield* SessionRevert.clear(yield* load()).pipe(Effect.provideService(EventV2.Service, events))
      expect((yield* load()).revert).toBeUndefined()

      // cleanup-on-prompt → commit
      yield* SessionRevert.stage({ session: yield* load(), messageID: boundary, files: false }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.provideService(EventV2.Service, events),
      )
      yield* SessionRevert.commit(yield* load()).pipe(Effect.provideService(EventV2.Service, events))
      expect((yield* load()).revert).toBeUndefined()
      expect(
        (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all()).map((row) => row.id),
      ).toEqual([boundary])
    }),
  )

  it.effect("busy authority is SessionExecution.active (empty under noop)", () =>
    Effect.gen(function* () {
      const execution = yield* SessionExecution.Service
      const active = yield* execution.active
      expect(active.has(sessionID)).toBe(false)
    }).pipe(Effect.provide(SessionExecution.noopLayer)),
  )
})
