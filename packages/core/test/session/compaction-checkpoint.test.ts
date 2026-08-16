import { describe, expect } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { CompactionCheckpoint } from "@opencode-ai/core/session/compaction-checkpoint"
import { PromptTapeStore } from "@opencode-ai/core/session/runner/prompt-tape-store"
import { SessionRuntime } from "@opencode-ai/core/session/runtime"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

const it = testEffect(Layer.empty)

const withDb = (repo: string, sessionID: SessionV2.ID, body: Effect.Effect<void, unknown, Database.Service>) => {
  const current = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(repo) })),
  )
  const graph = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]), [[Location.node, current]])
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(repo), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "chk",
        directory: repo,
        title: "chk",
        version: "test",
        agent: "build",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* body
  }).pipe(Effect.provide(graph))
}

describe("W7 compaction checkpoint", () => {
  it.live("tape hash before compact equals after uncompact", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "oc-chk-")))
      const sessionID = SessionV2.ID.make(`ses_chk_${Date.now()}`)
      yield* withDb(
        repo,
        sessionID,
        Effect.gen(function* () {
          PromptTapeStore.set(String(sessionID), 0, {
            system: "sys",
            messages: [{ role: "user", content: "hello" }],
          } as never)
          PromptTapeStore.setLastSeq(String(sessionID), 0, 3)
          const before = hash(CompactionCheckpoint.snapshot(String(sessionID)))
          yield* CompactionCheckpoint.write({
            sessionID: String(sessionID),
            tapeJson: JSON.stringify(CompactionCheckpoint.snapshot(String(sessionID))),
            messageIdsJson: JSON.stringify(["msg_a"]),
          })
          PromptTapeStore.clear(String(sessionID))
          expect(CompactionCheckpoint.snapshot(String(sessionID))).toEqual([])
          const restored = yield* CompactionCheckpoint.restore(String(sessionID))
          expect(restored).toBe(true)
          expect(hash(CompactionCheckpoint.snapshot(String(sessionID)))).toBe(before)
        }),
      )
    }),
  )

  it.live("uncompact restores messages hidden by a later compaction row", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "oc-chk-msg-")))
      const sessionID = SessionV2.ID.make(`ses_chk_msg_${Date.now()}`)
      yield* withDb(
        repo,
        sessionID,
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const created = DateTime.makeUnsafe(1)
          const keep = SessionMessage.ID.make("msg_keep_user")
          const encoded = encodeMessage(
            SessionMessage.Assistant.make({
              id: keep,
              type: "assistant",
              agent: "build",
              model,
              content: [],
              time: { created },
            }),
          )
          const { id: _id, type, ...data } = encoded
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: keep,
              session_id: sessionID,
              type,
              seq: 1,
              time_created: 1,
              time_updated: 1,
              data,
            })
            .run()
            .pipe(Effect.orDie)
          yield* CompactionCheckpoint.write({
            sessionID: String(sessionID),
            tapeJson: JSON.stringify([]),
          })
          const compaction = SessionMessage.ID.make("msg_compaction")
          const cencoded = encodeMessage(
            SessionMessage.Compaction.make({
              id: compaction,
              type: "compaction",
              reason: "manual",
              summary: "sum",
              time: { created: DateTime.makeUnsafe(2) },
            }),
          )
          const { id: _cid, type: ctype, ...cdata } = cencoded
          yield* db
            .insert(SessionMessageTable)
            .values({
              id: compaction,
              session_id: sessionID,
              type: ctype,
              seq: 2,
              time_created: 2,
              time_updated: 2,
              data: cdata,
            })
            .run()
            .pipe(Effect.orDie)
          const restored = yield* CompactionCheckpoint.restore(String(sessionID))
          expect(restored).toBe(true)
          const rows = yield* db.select().from(SessionMessageTable).all().pipe(Effect.orDie)
          expect(rows.map((row) => String(row.id))).toContain("msg_keep_user")
          expect(rows.map((row) => String(row.id))).not.toContain("msg_compaction")
        }),
      )
    }),
  )

  it.live("/loop abort then uncompact keeps user_abort", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "oc-chk-abort-")))
      const sessionID = SessionV2.ID.make(`ses_chk_abort_${Date.now()}`)
      yield* withDb(
        repo,
        sessionID,
        Effect.gen(function* () {
          yield* CompactionCheckpoint.write({
            sessionID: String(sessionID),
            tapeJson: JSON.stringify([]),
          })
          const runtime = yield* SessionRuntime.Service
          const inst = yield* runtime.getOrCreate(String(sessionID))
          yield* inst.terminal.request("user_abort")
          const restored = yield* CompactionCheckpoint.restore(String(sessionID))
          expect(restored).toBe(true)
          expect((yield* inst.terminal.snapshot).reason).toBe("user_abort")
        }).pipe(Effect.provide(SessionRuntime.layerForTest)),
      )
    }),
  )
})
