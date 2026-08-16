import { describe, expect } from "bun:test"
import { realpathSync } from "node:fs"
import { Effect, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Hooks, dispatch, loadFile } from "@opencode-ai/core/hooks"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { toolIdentity, executeTool } from "../lib/tool"

const sessionID = SessionV2.ID.make("ses_hooks_bash")
const spawns: Array<{ command: string }> = []
const assertions: PermissionV2.AssertInput[] = []

const permit = (input: PermissionV2.AssertInput) =>
  Effect.sync(() => {
    assertions.push(input)
  })

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: permit,
    assertPolicyAsk: permit,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const appProcess = Layer.succeed(
  AppProcess.Service,
  {
    spawn: (command: ChildProcess.Command) =>
      Effect.sync(() => {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command")
        spawns.push({ command: command.command })
        return {
          pid: 4242,
          all: Stream.make(Buffer.from("hello\n") as Uint8Array),
          exitCode: Effect.succeed(0),
        }
      }),
  } as unknown as AppProcess.Interface,
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

const backgroundJob = Layer.succeed(
  BackgroundJob.Service,
  BackgroundJob.Service.of({
    list: () => Effect.succeed([]),
    get: () => Effect.succeed(undefined),
    start: (input) =>
      Effect.gen(function* () {
        yield* input.run
        return {
          id: "job_hooks_bash",
          type: input.type,
          title: input.title,
          status: "running" as const,
          started_at: Date.now(),
          metadata: input.metadata,
        }
      }),
    patch: () => Effect.void,
    extend: () => Effect.succeed(false),
    wait: () => Effect.succeed({ timedOut: false, info: undefined }),
    waitForPromotion: () => Effect.never,
    promote: () => Effect.succeed(undefined),
    cancel: () => Effect.succeed(undefined),
  }),
)

const spec = (command: string, timeout: number) => {
  const loaded = loadFile(
    JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command, timeout }] }],
      },
    }),
    { id: "global:deny", origin: "global", file: "/tmp/hooks-deny.json" },
  )
  if (!loaded.ok) throw new Error(loaded.error)
  return loaded.spec
}

const hooksFor = (command: string, timeout: number) =>
  Layer.succeed(
    Hooks.Service,
    Hooks.Service.of({
      load: () => Effect.succeed([spec(command, timeout)]),
      dispatch: (input) =>
        dispatch({
          event: input.event,
          sessionID: input.sessionID,
          cwd: process.cwd(),
          toolName: input.toolName,
          toolInput: input.toolInput,
          specs: [spec(command, timeout)],
          handlers: [],
          sessionIDForWrap: input.sessionID,
        }),
      register: () => Effect.void,
      list: () =>
        Effect.succeed({
          loaded: [{ id: "global:deny", origin: "global", file: "/tmp/hooks-deny.json" }],
          untrusted: false,
        }),
      ensureSessionStart: () => Effect.succeed({ _tag: "Allow" as const }),
      trust: () => Effect.succeed("/tmp"),
      reload: () => Effect.void,
    }),
  )

const run = (directory: string, hooks: Layer.Layer<Hooks.Service>) =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    return yield* executeTool(registry, {
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call" as const, id: "call-bash", name: "bash", input: { command: "pwd" } },
    })
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        AppNodeBuilder.build(
          LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, BashTool.node]),
          [
            [
              Location.node,
              Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
              ),
            ],
            [PermissionV2.node, permission],
            [AppProcess.node, appProcess],
            [BackgroundJob.node, backgroundJob],
            [Config.node, config],
            [EventV2.node, events],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ],
        ),
        hooks,
      ),
    ),
  )

const it = testEffect(Layer.empty)

describe("W5 live bash PreToolUse", () => {
  it.live("exit 2 matcher bash returns tool error and does not spawn", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          spawns.length = 0
          assertions.length = 0
          const result = yield* run(realpathSync(tmp.path), hooksFor("exit 2", 5))
          expect(result.type).toBe("error")
          if (result.type === "error") expect(result.value).toContain("Hook denied")
          expect(spawns).toEqual([])
          expect(assertions.length).toBeGreaterThan(0)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("timeout matcher bash is deny and does not spawn", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          spawns.length = 0
          const result = yield* run(realpathSync(tmp.path), hooksFor("sleep 10", 1))
          expect(result.type).toBe("error")
          if (result.type === "error") expect(result.value).toContain("Hook denied")
          expect(spawns).toEqual([])
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
