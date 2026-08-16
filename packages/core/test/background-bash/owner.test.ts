import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { pinSession } from "@opencode-ai/core/sandbox/resolve"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { JobTool } from "@opencode-ai/core/tool/job"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { eq } from "drizzle-orm"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { executeTool, toolIdentity } from "../lib/tool"

const sessionA = SessionV2.ID.make("ses_job_owner_a")
const sessionB = SessionV2.ID.make("ses_job_owner_b")

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
    reload: () => Effect.void,
  }),
)

const withTools = <A, E, R>(directory: string, body: () => Effect.Effect<A, E, R>) => {
  pinSession(sessionA, "off")
  pinSession(sessionB, "off")
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return body().pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          EventV2.node,
          SessionStore.node,
          PermissionSaved.node,
          AgentV2.node,
          PermissionV2.node,
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          BackgroundJob.node,
          BashTool.node,
          JobTool.node,
        ]),
        [
          [Location.node, activeLocation],
          [Config.node, config],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

function setup(directory: string, sessionID: SessionV2.ID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: String(sessionID),
        directory,
        title: String(sessionID),
        version: "test",
        agent: "build",
        sandbox_profile: "off",
      })
      .run()
      .pipe(Effect.orDie)
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("build"), (agent) => {
        agent.mode = "primary"
        agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      }),
    )
  })
}

const jobCall = (sessionID: SessionV2.ID, input: typeof JobTool.Input.Type) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-job-${input.action}`, name: "job", input },
})

const it = testEffect(Layer.empty)

describe("job owner binding", () => {
  it.live("other session get/wait/kill is not-found and does not cancel the spawn", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withTools(tmp.path, () =>
          Effect.gen(function* () {
            yield* setup(tmp.path, sessionA)
            yield* setup(tmp.path, sessionB)
            const jobs = yield* BackgroundJob.Service
            const registry = yield* ToolRegistry.Service
            const latch = yield* Deferred.make<void>()
            const job = yield* jobs.start({
              type: "bash",
              metadata: { sessionId: sessionA },
              run: Deferred.await(latch).pipe(Effect.as("secret-output")),
            })
            expect(job.status).toBe("running")

            const get = yield* executeTool(registry, jobCall(sessionB, { action: "get", id: job.id }))
            expect(get).toMatchObject({ type: "error" })
            expect(JSON.stringify(get)).toContain("not found")

            const wait = yield* executeTool(registry, jobCall(sessionB, { action: "wait", id: job.id, timeout: 10 }))
            expect(wait).toMatchObject({ type: "error" })

            const kill = yield* executeTool(registry, jobCall(sessionB, { action: "kill", id: job.id }))
            expect(kill).toMatchObject({ type: "error" })
            expect((yield* jobs.get(job.id))?.status).toBe("running")

            const mine = yield* executeTool(registry, jobCall(sessionA, { action: "get", id: job.id }))
            expect(mine).not.toMatchObject({ type: "error" })
            expect(JSON.stringify(mine)).toContain("jobID=")
            expect(JSON.stringify(mine)).toContain("status=running")

            yield* Deferred.succeed(latch, undefined)
            expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("completed")
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
