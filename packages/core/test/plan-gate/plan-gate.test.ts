import { describe, expect, test } from "bun:test"
import path from "node:path"
import { ChildProcess } from "effect/unstable/process"
import { Effect, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { PlanGate, isPlanPath } from "@opencode-ai/core/session/plan-gate"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WriteTool } from "@opencode-ai/core/tool/write"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Global } from "@opencode-ai/core/global"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { toolIdentity, executeTool } from "../lib/tool"
import fs from "node:fs/promises"

const sessionID = SessionV2.ID.make("ses_plan_gate")

describe("W8b isPlanPath", () => {
  test("only the two plan trees match", () => {
    const loc = "/proj"
    expect(isPlanPath(path.join(loc, ".opencode", "plans", "foo.md"), loc)).toBe(true)
    expect(isPlanPath(path.join(Global.Path.data, "plans", "bar.md"), loc)).toBe(true)
    expect(isPlanPath(path.join(loc, "src", "x.ts"), loc)).toBe(false)
    expect(isPlanPath(path.join(loc, ".opencode", "plans", "foo.ts"), loc)).toBe(false)
  })
})

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

const setupSession = (db: Database.Interface["db"], directory: string, planMode: number, agent = "build") =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "plan-gate",
        directory,
        title: "plan-gate",
        version: "test",
        agent,
        plan_mode: planMode,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    if (planMode === 1 || agent === "plan") {
      yield* db
        .update(SessionTable)
        .set({ plan_mode: planMode, agent })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
    }
  })

const it = testEffect(Layer.empty)

describe("W8b PlanGate mutations", () => {
  it.live("plan_mode=1 blocks src write and allows plan md; bash redirect is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const current = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const graph = AppNodeBuilder.build(
            LayerNode.group([
              Database.node,
              EventV2.node,
              ToolRegistry.node,
              ToolRegistry.toolsNode,
              LocationMutation.node,
              FileMutation.node,
              WriteTool.node,
              PlanGate.node,
            ]),
            [
              [Location.node, current],
              [Permission.node, permission],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ],
          )
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* setupSession(db, tmp.path, 1, "build")
            const registry = yield* ToolRegistry.Service
            const blocked = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call" as const, id: "w1", name: "write", input: { path: "src/x.ts", content: "no" } },
            })
            expect(blocked.type).toBe("error")
            expect(yield* Effect.promise(() => fs.stat(path.join(tmp.path, "src/x.ts")).then(() => true, () => false))).toBe(
              false,
            )
            yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode", "plans"), { recursive: true }))
            const allowed = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id: "w2",
                name: "write",
                input: { path: ".opencode/plans/foo.md", content: "# plan\n" },
              },
            })
            expect(allowed.type).not.toBe("error")
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, ".opencode/plans/foo.md"), "utf8"))).toContain(
              "plan",
            )
            const bash = yield* (yield* PlanGate.Service).assertMutation({
              sessionID,
              kind: "bash",
              command: "printf x > src/x.ts",
            }).pipe(Effect.result)
            expect(bash._tag).toBe("Failure")
            const lsRedirect = yield* (yield* PlanGate.Service).assertMutation({
              sessionID,
              kind: "bash",
              command: "ls > src/x.ts",
            }).pipe(Effect.result)
            expect(lsRedirect._tag).toBe("Failure")
            const catRedirect = yield* (yield* PlanGate.Service).assertMutation({
              sessionID,
              kind: "bash",
              command: "cat > src/x.ts",
            }).pipe(Effect.result)
            expect(catRedirect._tag).toBe("Failure")
            const catPlanRedirect = yield* (yield* PlanGate.Service).assertMutation({
              sessionID,
              kind: "bash",
              command: "cat .opencode/plans/foo.md > src/x.ts",
            }).pipe(Effect.result)
            expect(catPlanRedirect._tag).toBe("Failure")
            expect(yield* Effect.promise(() => fs.stat(path.join(tmp.path, "src/x.ts")).then(() => true, () => false))).toBe(
              false,
            )
          }).pipe(Effect.provide(graph))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("agent plan with plan_mode=0 does not block src write", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const current = Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
          )
          const graph = AppNodeBuilder.build(
            LayerNode.group([
              Database.node,
              EventV2.node,
              ToolRegistry.node,
              ToolRegistry.toolsNode,
              LocationMutation.node,
              FileMutation.node,
              WriteTool.node,
              PlanGate.node,
            ]),
            [
              [Location.node, current],
              [Permission.node, permission],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ],
          )
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* setupSession(db, tmp.path, 0, "plan")
            const registry = yield* ToolRegistry.Service
            const result = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call" as const, id: "w3", name: "write", input: { path: "src/ok.ts", content: "yes" } },
            })
            expect(result.type).not.toBe("error")
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "src/ok.ts"), "utf8"))).toBe("yes")
          }).pipe(Effect.provide(graph))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("live bash redirect is denied with no spawn; after plan_mode=0 write is allowed", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
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
        const current = Layer.succeed(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
        )
        const graph = AppNodeBuilder.build(
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
            FileMutation.node,
            BackgroundJob.node,
            WriteTool.node,
            BashTool.node,
            PlanGate.node,
          ]),
          [
            [Location.node, current],
            [AppProcess.node, appProcess],
            [Config.node, config],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ],
        )
        return Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* setupSession(db, tmp.path, 1, "build")
          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("build"), (agent) => {
              agent.mode = "primary"
              agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
            }),
          )
          const registry = yield* ToolRegistry.Service
          const blocked = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call" as const,
              id: "b1",
              name: "bash",
              input: { command: "printf x > src/x.ts" },
            },
          })
          expect(blocked.type).toBe("error")
          expect(spawns).toEqual([])
          expect(yield* Effect.promise(() => fs.stat(path.join(tmp.path, "src/x.ts")).then(() => true, () => false))).toBe(
            false,
          )
          const wrapped = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: {
              type: "tool-call" as const,
              id: "b2",
              name: "bash",
              input: { command: "bash -c 'ls > src/wrapped.ts'" },
            },
          })
          expect(wrapped.type).toBe("error")
          expect(spawns).toEqual([])
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "src/wrapped.ts")).then(() => true, () => false)),
          ).toBe(false)
          yield* db
            .update(SessionTable)
            .set({ plan_mode: 0, agent: "build" })
            .where(eq(SessionTable.id, sessionID))
            .run()
            .pipe(Effect.orDie)
          const allowed = yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call" as const, id: "w-exit", name: "write", input: { path: "src/a.ts", content: "ok" } },
          })
          expect(allowed.type).not.toBe("error")
          expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "src/a.ts"), "utf8"))).toBe("ok")
        }).pipe(Effect.provide(graph))
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
