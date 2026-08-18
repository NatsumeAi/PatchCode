import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Event } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { pinSession } from "@opencode-ai/core/sandbox/resolve"
import { Session } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { eq } from "drizzle-orm"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { executeTool, toolIdentity } from "../lib/tool"

const sessionID = Session.ID.make("ses_bash_cap")

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
    reload: () => Effect.void,
  }),
)

const withTool = <A, E, R>(directory: string, body: () => Effect.Effect<A, E, R>) => {
  pinSession(sessionID, "off")
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return body().pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          Event.node,
          SessionStore.node,
          PermissionSaved.node,
          Agent.node,
          Permission.node,
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          BackgroundJob.node,
          BashTool.node,
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

function setup(directory: string) {
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
        slug: "bash-cap",
        directory,
        title: "bash-cap",
        version: "test",
        agent: "build",
        sandbox_profile: "off",
      })
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("build"), (agent) => {
        agent.mode = "primary"
        agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      }),
    )
  })
}

const it = testEffect(Layer.empty)

describe("bash job cap", () => {
  it.live("9th background bash on one session fails Job.Busy", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withTool(tmp.path, () =>
          Effect.gen(function* () {
            yield* setup(tmp.path)
            const jobs = yield* BackgroundJob.Service
            const registry = yield* ToolRegistry.Service
            const latch = yield* Deferred.make<void>()
            for (let i = 0; i < BashTool.MAX_RUNNING_BASH; i++) {
              yield* jobs.start({
                type: "bash",
                metadata: { sessionId: sessionID },
                run: Deferred.await(latch).pipe(Effect.as("held")),
              })
            }
            const ninth = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id: "call-ninth",
                name: "bash",
                input: { command: "echo too-many", background: true },
              },
            })
            expect(ninth).toMatchObject({ type: "error" })
            expect(JSON.stringify(ninth)).toContain("Job.Busy")
            const running = (yield* jobs.list()).filter(
              (job) => job.type === "bash" && job.status === "running" && job.metadata?.sessionId === sessionID,
            )
            expect(running.length).toBe(BashTool.MAX_RUNNING_BASH)
            yield* Deferred.succeed(latch, undefined)
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
