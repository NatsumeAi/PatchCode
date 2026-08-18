import { describe, expect } from "bun:test"
import { realpathSync } from "node:fs"
import { Effect, Layer } from "effect"
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
import { JobTool } from "@opencode-ai/core/tool/job"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { eq } from "drizzle-orm"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { executeTool, settleTool, toolIdentity } from "../lib/tool"

const sessionID = Session.ID.make("ses_bash_job_live")

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
    reload: () => Effect.void,
  }),
)

// `sleep` is builtin policy-ask; `* allow` does not auto-approve it. Live spawn
// tests still use real AppProcess — only the permission prompt is skipped.
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    assert: () => Effect.void,
    assertPolicyAsk: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const withLive = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  pinSession(sessionID, "off")
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
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
          JobTool.node,
        ]),
        [
          [Location.node, activeLocation],
          [Permission.node, permission],
          [Config.node, config],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const bashCall = (input: typeof BashTool.Input.Type, id = "call-bash-live") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "bash", input },
})

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
        slug: "bash-job-live",
        directory,
        title: "bash-job-live",
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

describe.skipIf(process.platform === "win32")("bash background job live", () => {
  it.live("background sleep returns jobID in under 200ms while pid is alive", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withLive(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* setup(tmp.path)
            const jobs = yield* BackgroundJob.Service
            const started = Date.now()
            const result = yield* settleTool(registry, bashCall({ command: "sleep 5", background: true }))
            expect(Date.now() - started).toBeLessThan(200)
            expect(result.result).toMatchObject({ type: "content" })
            const jobID = (result.output?.structured as { jobID?: string }).jobID
            expect(jobID).toBeTruthy()
            const info = yield* jobs.get(jobID!)
            expect(info?.status).toBe("running")
            const pid = Number(info?.metadata?.pid)
            expect(pid).toBeGreaterThan(1)
            expect(alive(pid)).toBe(true)
            const waited = yield* jobs.wait({ id: jobID!, timeout: 10_000 })
            expect(waited.info?.status).toBe("completed")
            expect(alive(pid)).toBe(false)
            expect(realpathSync(tmp.path)).toBeTruthy()
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("job kill on sleep 30 cancels and reaps the pid", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withLive(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* setup(tmp.path)
            const jobs = yield* BackgroundJob.Service
            const result = yield* settleTool(registry, bashCall({ command: "sleep 30", background: true }, "kill-call"))
            const jobID = (result.output?.structured as { jobID?: string }).jobID!
            const pid = Number((yield* jobs.get(jobID))?.metadata?.pid)
            expect(alive(pid)).toBe(true)
            const cancelled = yield* jobs.cancel(jobID)
            expect(cancelled?.status).toBe("cancelled")
            yield* Effect.sleep(200)
            expect(alive(pid)).toBe(false)
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("foreground echo hello still returns hello", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withLive(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* setup(tmp.path)
            const result = yield* executeTool(registry, bashCall({ command: "echo hello" }, "echo-call"))
            expect(JSON.stringify(result)).toContain("hello")
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("promote leaves the pid alive", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withLive(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* setup(tmp.path)
            const jobs = yield* BackgroundJob.Service
            const result = yield* settleTool(
              registry,
              bashCall({ command: "sleep 30", background: true }, "promote-call"),
            )
            const jobID = (result.output?.structured as { jobID?: string }).jobID!
            const before = yield* jobs.get(jobID)
            const pid = Number(before?.metadata?.pid)
            const promoted = yield* jobs.promote(jobID)
            expect(promoted?.metadata?.background).toBe(true)
            expect(Number(promoted?.metadata?.pid)).toBe(pid)
            expect(alive(pid)).toBe(true)
            yield* jobs.cancel(jobID)
            yield* Effect.sleep(200)
            expect(alive(pid)).toBe(false)
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
