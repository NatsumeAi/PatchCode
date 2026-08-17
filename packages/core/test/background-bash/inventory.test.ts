import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
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
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { pinSession } from "@opencode-ai/core/sandbox/resolve"
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

const sessionID = SessionV2.ID.make("ses_bash_inventory")
const bashSource = fs.readFileSync(path.join(import.meta.dir, "../../src/tool/bash.ts"), "utf8")
const coreSrc = path.join(import.meta.dir, "../../src")

describe("W3 inventory", () => {
  test("bash.ts starts a BackgroundJob after decide/assert", () => {
    expect(bashSource).toContain("BackgroundJob")
    expect(bashSource).toContain("jobs.start")
    const startAt = bashSource.indexOf("jobs.start(")
    const decideAt = bashSource.indexOf("execPolicy.decideCommand")
    const assertAt = Math.min(
      ...["permission.assert(", "permission.assertPolicyAsk("]
        .map((needle) => bashSource.indexOf(needle))
        .filter((index) => index >= 0),
    )
    expect(startAt).toBeGreaterThan(0)
    expect(decideAt).toBeGreaterThan(0)
    expect(assertAt).toBeGreaterThan(0)
    expect(startAt).toBeGreaterThan(decideAt)
    expect(startAt).toBeGreaterThan(assertAt)
  })

  test("no BashJob or ShellJob export exists", () => {
    const walk = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      return entries.flatMap((entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return walk(full)
        if (!entry.name.endsWith(".ts")) return []
        return fs.readFileSync(full, "utf8").includes("export") && /export\s+.*\b(BashJob|ShellJob)\b/.test(fs.readFileSync(full, "utf8"))
          ? [full]
          : []
      })
    }
    expect(walk(coreSrc).filter((file) => /BashJob|ShellJob/.test(fs.readFileSync(file, "utf8")))).toEqual([])
    expect(fs.existsSync(path.join(coreSrc, "tool/background-bash.ts"))).toBe(false)
  })
})

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
        slug: "inventory",
        directory,
        title: "inventory",
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

const it = testEffect(Layer.empty)

describe("W3 deny does not start", () => {
  it.live("background rm -rf / creates no running bash row", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withTool(tmp.path, () =>
          Effect.gen(function* () {
            yield* setup(tmp.path)
            const jobs = yield* BackgroundJob.Service
            const registry = yield* ToolRegistry.Service
            const result = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id: "deny-bg",
                name: "bash",
                input: { command: "rm -rf /", background: true },
              },
            })
            expect(result).toMatchObject({ type: "error" })
            const running = (yield* jobs.list()).filter((job) => job.type === "bash" && job.status === "running")
            expect(running).toEqual([])
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
