import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Event } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Permission } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Event.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      Permission.node,
    ]),
    [[Location.node, current]],
  ),
)

describe("missing Agent is deny", () => {
  it.effect("unknown agent assert is BlockedError", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: Session.ID.make("ses_missing_agent"),
          project_id: Project.ID.global,
          slug: "missing-agent",
          directory: "/project",
          title: "missing-agent",
          version: "test",
          agent: "ghost",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)

      const service = yield* Permission.Service
      const blocked = yield* service
        .assert({
          sessionID: Session.ID.make("ses_missing_agent"),
          action: "read",
          resources: ["a.ts"],
          agent: Agent.ID.make("ghost"),
        })
        .pipe(Effect.flip)
      expect(blocked).toBeInstanceOf(Permission.BlockedError)
    }),
  )
})
