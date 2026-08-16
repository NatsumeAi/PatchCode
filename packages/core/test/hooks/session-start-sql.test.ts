import { describe, expect } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Hooks } from "@opencode-ai/core/hooks"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Tools } from "@opencode-ai/core/tool/tools"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { executeTool } from "../lib/tool"

const dummy = Tool.make({
  description: "n",
  input: Schema.Struct({}),
  output: Schema.Struct({ ok: Schema.Boolean }),
  execute: () => Effect.succeed({ ok: true }),
})

const sessionID = SessionV2.ID.make(`ses_hooks_sql_${Date.now()}`)
const call = {
  sessionID,
  agent: AgentV2.ID.make("build"),
  assistantMessageID: SessionMessage.ID.make("msg_hooks_sql"),
  call: { type: "tool-call" as const, id: "call-dummy", name: "dummy", input: {} },
}

const it = testEffect(Layer.empty)

describe("W5 SessionStart SQL reconnect", () => {
  it.live("deny is stored on the session row and reconnect does not re-fire", () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "oc-hooks-sql-")))
      const current = Layer.succeed(
        Location.Service,
        Location.Service.of(location({ directory: AbsolutePath.make(repo) })),
      )
      const graph = AppNodeBuilder.build(
        LayerNode.group([Database.node, EventV2.node, ToolRegistry.node, ToolRegistry.toolsNode, Hooks.node]),
        [
          [Location.node, current],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      )

      yield* Effect.gen(function* () {
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
            slug: "hooks-sql",
            directory: repo,
            title: "hooks-sql",
            version: "test",
            agent: "build",
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)

        let starts = 0
        const hooks = yield* Hooks.Service
        yield* hooks.register({
          id: "start",
          event: "SessionStart",
          run: () =>
            Effect.sync(() => {
              starts++
              return { _tag: "Deny" as const, reason: "no", hookId: "start" }
            }),
        })
        const tools = yield* Tools.Service
        yield* tools.register({ dummy })
        const registry = yield* ToolRegistry.Service
        const first = yield* executeTool(registry, call)
        expect(first).toEqual({ type: "error", value: "session blocked by SessionStart hook" })
        expect(starts).toBe(1)
        const row = yield* db
          .select({ hooks_session_start: SessionTable.hooks_session_start })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        expect(row?.hooks_session_start).toBe("deny")

        const second = yield* executeTool(registry, call)
        expect(second).toEqual({ type: "error", value: "session blocked by SessionStart hook" })
        expect(starts).toBe(1)

        const gated = yield* hooks.ensureSessionStart(sessionID)
        expect(gated).toMatchObject({ _tag: "Deny", hookId: "session-start" })
        expect(starts).toBe(1)
      }).pipe(Effect.provide(graph))
    }),
  )
})
