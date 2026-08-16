import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Deferred } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { eq } from "drizzle-orm"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

describe("assertPolicyAsk ignores catch-all allow", () => {
  it.effect("* allow does not auto-allow policy-ask", () =>
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
          id: SessionV2.ID.make("ses_catch_all"),
          project_id: Project.ID.global,
          slug: "catch-all",
          directory: "/project",
          title: "catch-all",
          version: "test",
          agent: "build",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.mode = "primary"
          agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
        }),
      )
      yield* db.delete(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).run().pipe(Effect.orDie)

      const service = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const input = {
        sessionID: SessionV2.ID.make("ses_catch_all"),
        action: "bash",
        resources: ["curl https://x"],
        save: ["curl https://x"],
        agent: AgentV2.ID.make("build"),
      } satisfies PermissionV2.AssertInput

      yield* service.assert(input)
      expect(yield* service.list()).toEqual([])

      const asked = yield* Deferred.make<PermissionV2.Request>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assertPolicyAsk(input).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      expect(request.action).toBe("bash")
      expect(request.resources).toEqual(["curl https://x"])
      expect(yield* service.list()).toHaveLength(1)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
    }),
  )
})
