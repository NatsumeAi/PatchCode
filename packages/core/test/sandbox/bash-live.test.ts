import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { pinSession } from "@opencode-ai/core/sandbox/resolve"
import { SessionV2 } from "@opencode-ai/core/session"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "../fixture/location"
import { executeTool, settleTool, toolIdentity } from "../lib/tool"

const sessionID = SessionV2.ID.make("ses_bash_live_sandbox")

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
const events = Layer.succeed(
  EventV2.Service,
  {
    publish: () => Effect.succeed({ durable: { aggregateID: sessionID, seq: 1, version: 1 } }),
  } as unknown as EventV2.Interface,
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
    reload: () => Effect.void,
  }),
)

const jobRows = new Map<string, BackgroundJob.Info>()
const inlineJobs = Layer.succeed(
  BackgroundJob.Service,
  BackgroundJob.Service.of({
    list: () => Effect.succeed([...jobRows.values()]),
    get: (id) => Effect.succeed(jobRows.get(id)),
    start: (input) =>
      Effect.gen(function* () {
        const id = input.id ?? "job_live"
        const running: BackgroundJob.Info = {
          id,
          type: input.type,
          title: input.title,
          status: "running",
          started_at: Date.now(),
          metadata: input.metadata,
        }
        jobRows.set(id, running)
        const output = yield* input.run
        jobRows.set(id, { ...jobRows.get(id)!, status: "completed", completed_at: Date.now(), output })
        return running
      }),
    patch: (id, metadata) =>
      Effect.sync(() => {
        const job = jobRows.get(id)
        if (job) jobRows.set(id, { ...job, metadata: { ...job.metadata, ...metadata } })
      }),
    extend: () => Effect.succeed(false),
    wait: ({ id }) => Effect.succeed({ timedOut: false, info: jobRows.get(id) }),
    waitForPromotion: () => Effect.never,
    promote: () => Effect.succeed(undefined),
    cancel: () => Effect.succeed(undefined),
  }),
)

const withLive = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
  jobRows.clear()
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, BashTool.node]),
        [
          [Location.node, activeLocation],
          [Permission.node, permission],
          [Config.node, config],
          [EventV2.node, events],
          [BackgroundJob.node, inlineJobs],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (command: string, workdir?: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-bash-live", name: "bash", input: { command, ...(workdir ? { workdir } : {}) } },
})

describe.skipIf(process.platform !== "linux")("bash live sandbox", () => {
  test("binary exists — missing bwrap is a hard fail on linux", async () => {
    expect(await Bun.file("/usr/bin/bwrap").exists()).toBe(true)
  })

  test("workspace: write inside Location ok; write outside is EROFS and host file absent", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "oc-bash-live-"))
    const probe = path.join(homedir(), "opencode-sandbox-probe")
    pinSession(sessionID, "workspace")
    try {
      await withLive(work, (registry) =>
        Effect.gen(function* () {
          const inside = yield* settleTool(registry, call("echo ok > inside.txt"))
          expect(inside.output?.structured).toMatchObject({ exit: 0 })
          const leaked = yield* settleTool(registry, call(`echo leaked > '${probe}'`))
          expect((leaked.output?.structured as { exit?: number } | undefined)?.exit).not.toBe(0)
        }),
      ).pipe(Effect.runPromise)
      expect(await readFile(path.join(work, "inside.txt"), "utf8")).toMatch(/ok/)
      expect(await Bun.file(probe).exists()).toBe(false)
    } finally {
      await rm(work, { recursive: true, force: true })
      await rm(probe, { force: true })
    }
  })

  test("read-only: word-only connect is ENETUNREACH", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "oc-bash-net-"))
    pinSession(sessionID, "read-only")
    try {
      await withLive(work, (registry) =>
        Effect.gen(function* () {
          const result = yield* settleTool(
            registry,
            call("curl -sS --connect-timeout 1 http://1.1.1.1/"),
          )
          expect((result.output?.structured as { exit?: number } | undefined)?.exit).not.toBe(0)
          const text = JSON.stringify(result.output ?? result.result)
          expect(text).toMatch(/Network is unreachable|Errno 101|ENETUNREACH|Could not resolve|Couldn't connect|Failed to connect|Connection refused/)
        }),
      ).pipe(Effect.runPromise)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  test("workspace deny: bash cat .env fails", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "oc-bash-env-"))
    pinSession(sessionID, "workspace")
    try {
      await writeFile(path.join(work, ".env"), "SECRET=1\n")
      await withLive(work, (registry) =>
        Effect.gen(function* () {
          const result = yield* settleTool(registry, call("cat .env"))
          expect((result.output?.structured as { exit?: number } | undefined)?.exit).not.toBe(0)
          const text = JSON.stringify(result.output ?? result.result)
          expect(text).not.toContain("SECRET=1")
        }),
      ).pipe(Effect.runPromise)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })
})
