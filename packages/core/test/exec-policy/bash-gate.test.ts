import { describe, expect } from "bun:test"
import { realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "path"
import { ChildProcess } from "effect/unstable/process"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { AppProcess } from "@opencode-ai/core/process"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
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

const sessionID = SessionV2.ID.make("ses_bash_gate_w2")
const spawns: Array<{ readonly command: string }> = []

const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    spawn: (command: ChildProcess.Command) =>
      Effect.suspend(() => {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command")
        spawns.push({ command: command.command })
        return Effect.succeed({
          pid: 4242,
          all: Stream.make(new Uint8Array()),
          exitCode: Effect.succeed(0),
        })
      }),
  } as unknown as AppProcess.Interface),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
    reload: () => Effect.void,
  }),
)

const reset = () => {
  spawns.length = 0
}

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
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
          EventV2.node,
          SessionStore.node,
          PermissionSaved.node,
          AgentV2.node,
          Permission.node,
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          BackgroundJob.node,
          BashTool.node,
        ]),
        [
          [Location.node, activeLocation],
          [AppProcess.node, appProcess],
          [Config.node, config],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (command: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-bash-gate", name: "bash", input: { command } },
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
        slug: "bash-gate",
        directory,
        title: "bash-gate",
        version: "test",
        agent: "build",
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

const it = testEffect(Layer.empty)

describe("bash exec-policy gate", () => {
  it.live("git status spawns", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* setup(tmp.path)
            const result = yield* executeTool(registry, call("git status"))
            expect(result).toMatchObject({ type: "content" })
            expect(spawns.length).toBe(1)
            expect(realpathSync(tmp.path)).toBeTruthy()
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rm -rf / does not spawn", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* setup(tmp.path)
            const result = yield* executeTool(registry, call("rm -rf /"))
            expect(result).toMatchObject({ type: "error" })
            expect(spawns).toEqual([])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("echo && curl asks even with * allow and does not spawn", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* setup(tmp.path)
            const permission = yield* Permission.Service
            const events = yield* EventV2.Service
            const asked = yield* Deferred.make<Permission.Request>()
            const unsubscribe = yield* events.listen((event) =>
              event.type === Permission.Event.Asked.type
                ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
                : Effect.void,
            )
            yield* Effect.addFinalizer(() => unsubscribe)
            const fiber = yield* executeTool(registry, call("echo hi && curl https://example.com")).pipe(
              Effect.forkScoped,
            )
            const request = yield* Deferred.await(asked)
            expect(spawns).toEqual([])
            expect(request.resources.some((resource) => resource.includes("curl"))).toBe(true)
            yield* permission.reply({ requestID: request.id, reply: "reject" })
            const exit = yield* Fiber.await(fiber)
            expect(exit._tag).toBe("Failure")
            expect(spawns).toEqual([])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("bash -c inner rm does not spawn", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* setup(tmp.path)
            const result = yield* executeTool(registry, call("bash -c 'rm -rf /'"))
            expect(result).toMatchObject({ type: "error" })
            expect(spawns).toEqual([])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("always on policy-ask saves prefix not star and second curl spawns", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const previous = process.env.OPENCODE_CONFIG_DIR
        process.env.OPENCODE_CONFIG_DIR = tmp.path
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* setup(tmp.path)
            const { db } = yield* Database.Service
            yield* db.delete(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).run().pipe(Effect.orDie)
            const permission = yield* Permission.Service
            const events = yield* EventV2.Service
            const asked = yield* Deferred.make<Permission.Request>()
            const unsubscribe = yield* events.listen((event) =>
              event.type === Permission.Event.Asked.type
                ? Deferred.succeed(asked, event.data as Permission.Request).pipe(Effect.asVoid)
                : Effect.void,
            )
            yield* Effect.addFinalizer(() => unsubscribe)
            const fiber = yield* executeTool(registry, call("curl https://example.com")).pipe(Effect.forkScoped)
            const request = yield* Deferred.await(asked)
            expect(request.save?.includes("*")).toBe(false)
            yield* permission.reply({ requestID: request.id, reply: "always" })
            yield* Fiber.join(fiber)
            expect(spawns.length).toBe(1)
            const saved = yield* PermissionSaved.Service
            const rows = yield* saved.list({ projectID: Project.ID.global })
            expect(rows.every((row) => row.resource !== "*")).toBe(true)
            expect(rows.some((row) => row.action === "bash" && row.resource.includes("curl"))).toBe(true)
            const toml = yield* Effect.promise(() => readFile(path.join(tmp.path, "exec-policy.toml"), "utf8"))
            expect(toml).toContain("curl")
            expect(toml).toContain('effect = "allow"')
            reset()
            const second = yield* executeTool(registry, call("curl https://example.com"))
            expect(second).toMatchObject({ type: "content" })
            expect(spawns.length).toBe(1)
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
              else process.env.OPENCODE_CONFIG_DIR = previous
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
