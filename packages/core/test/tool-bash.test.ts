import fs from "fs/promises"
import { realpathSync } from "node:fs"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Event } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Permission } from "@opencode-ai/core/permission"
import { AppProcess } from "@opencode-ai/core/process"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { pinSession } from "@opencode-ai/core/sandbox/resolve"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = Session.ID.make("ses_bash_tool_test")
pinSession(sessionID, "off")
const assertions: Permission.AssertInput[] = []
const spawns: Array<{
  readonly command: string
  readonly cwd?: string
  readonly shell?: string | boolean
  readonly env?: Record<string, string>
}> = []
const published: Array<{ readonly type: string; readonly data: Record<string, unknown> }> = []
let denyAction: string | undefined
let spawnResult: AppProcess.RunResult = {
  command: "mock",
  exitCode: 0,
  output: Buffer.from("hello\n"),
  stdout: Buffer.from("hello\n"),
  stderr: Buffer.alloc(0),
  outputTruncated: false,
  stdoutTruncated: false,
  stderrTruncated: false,
}
let spawnFailure: AppProcess.AppProcessError | undefined
let spawnHang = false
let afterPermission = (_input: Permission.AssertInput): Effect.Effect<void> => Effect.void

const permit = (input: Permission.AssertInput) =>
  Effect.sync(() => assertions.push(input)).pipe(
    Effect.andThen(Effect.suspend(() => afterPermission(input))),
    Effect.andThen(
      input.action === denyAction ? Effect.fail(new Permission.BlockedError({ rules: [] })) : Effect.void,
    ),
  )
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
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
  AppProcess.Service.of({
    spawn: (command: ChildProcess.Command) =>
      Effect.suspend(() => {
        if (command._tag !== "StandardCommand") throw new Error("expected standard command")
        spawns.push({
          command: command.command,
          cwd: command.options.cwd,
          shell: command.options.shell,
          env: command.options.env as Record<string, string> | undefined,
        })
        if (spawnFailure) return Effect.fail(spawnFailure)
        const output = spawnResult.output ?? Buffer.alloc(0)
        // Hang after optional partial stdout so timeout can assert captured output is kept.
        const hangStream =
          spawnResult.output && spawnResult.output.length > 0
            ? Stream.concat(Stream.make(spawnResult.output.slice() as Uint8Array), Stream.never)
            : Stream.never
        return Effect.succeed({
          pid: 4242,
          all: spawnHang ? hangStream : Stream.make(output.slice() as Uint8Array),
          exitCode: spawnHang ? Effect.never : Effect.succeed(spawnResult.exitCode),
        })
      }),
  } as unknown as AppProcess.Interface),
)
const events = Layer.succeed(
  Event.Service,
  {
    publish: (definition: { readonly type: string }, data: Record<string, unknown>) =>
      Effect.sync(() => {
        published.push({ type: definition.type, data })
        return { durable: { aggregateID: data.sessionID, seq: published.length, version: 1 } }
      }),
  } as unknown as Event.Interface,
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
    reload: () => Effect.void,
  }),
)

const jobRows = new Map<string, BackgroundJob.Info>()
const backgroundJob = Layer.succeed(
  BackgroundJob.Service,
  BackgroundJob.Service.of({
    list: () => Effect.succeed([...jobRows.values()]),
    get: (id) => Effect.succeed(jobRows.get(id)),
    start: (input) =>
      Effect.gen(function* () {
        const id = input.id ?? "job_mock"
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
        const done: BackgroundJob.Info = {
          ...jobRows.get(id)!,
          status: "completed",
          completed_at: Date.now(),
          output,
        }
        jobRows.set(id, done)
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
    promote: (id) =>
      Effect.sync(() => {
        const job = jobRows.get(id)
        if (!job) return undefined
        const next = { ...job, metadata: { ...job.metadata, background: true } }
        jobRows.set(id, next)
        return next
      }),
    cancel: (id) =>
      Effect.sync(() => {
        const job = jobRows.get(id)
        if (!job) return undefined
        const next = { ...job, status: "cancelled" as const, completed_at: Date.now() }
        jobRows.set(id, next)
        return next
      }),
  }),
)

const reset = () => {
  assertions.length = 0
  spawns.length = 0
  published.length = 0
  jobRows.clear()
  denyAction = undefined
  spawnFailure = undefined
  spawnHang = false
  afterPermission = () => Effect.void
  spawnResult = {
    command: "mock",
    exitCode: 0,
    output: Buffer.from("hello\n"),
    stdout: Buffer.from("hello\n"),
    stderr: Buffer.alloc(0),
    outputTruncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

const withTool = <A, E, R>(
  directory: string,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  processLayer: Layer.Layer<AppProcess.Service> = appProcess,
  hostLayer?: Layer.Layer<BashTool.HostService>,
) => {
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
          [AppProcess.node, processLayer],
          [BackgroundJob.node, backgroundJob],
          [Config.node, config],
          [Event.node, events],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ...(hostLayer ? ([[BashTool.hostNode, hostLayer]] as const) : []),
        ],
      ),
    ),
  )
}

const call = (input: typeof BashTool.Input.Type, id = "call-bash") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "bash", input },
})

const progressEvents = () => published.filter((event) => event.type === SessionEvent.Tool.Progress.type)

const it = testEffect(Layer.empty)

describe("BashTool", () => {
  it.live("registers and returns structured successful output from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const definitions = yield* toolDefinitions(registry)
            expect(definitions.map((tool) => tool.name)).toEqual(["bash"])
            expect(definitions[0]?.inputSchema).toHaveProperty("properties.background")
            expect(definitions[0]?.description).toContain("Git and GitHub")
            expect(definitions[0]?.description).toContain("workdir")
            expect(definitions[0]?.description).toContain("If background is true")
            expect(definitions[0]?.inputSchema).not.toHaveProperty("properties.description")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.output")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.command")
            expect(definitions[0]?.outputSchema).not.toHaveProperty("properties.cwd")
            expect(yield* toolDefinitions(registry, [{ action: "bash", resource: "*", effect: "deny" }])).toEqual([])
            expect(yield* settleTool(registry, call({ command: "pwd" }))).toEqual({
              result: {
                type: "content",
                value: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "Command exited with code 0." },
                ],
              },
              output: {
                structured: {
                  exit: 0,
                  truncated: false,
                },
                content: [
                  { type: "text", text: "hello\n" },
                  { type: "text", text: "Command exited with code 0." },
                ],
              },
            })
            expect(spawns).toMatchObject([{ command: "pwd", cwd: realpathSync(tmp.path) }])
            expect(progressEvents()).toEqual([])
            expect(assertions).toMatchObject([{ sessionID, action: "bash", resources: ["pwd"], save: ["pwd"] }])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("merges host shell.env into the spawned command environment", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(
          tmp.path,
          (registry) =>
            Effect.gen(function* () {
              yield* executeTool(registry, call({ command: "pwd" }))
              expect(spawns[0]?.env).toMatchObject({ OPENCODE_TEST_SHELL_ENV: "1" })
            }),
          appProcess,
          Layer.succeed(
            BashTool.HostService,
            BashTool.HostService.of({
              env: () => Effect.succeed({ OPENCODE_TEST_SHELL_ENV: "1" }),
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("resolves a relative workdir from the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.mkdir(path.join(tmp.path, "src"))).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => expect(spawns).toMatchObject([{ cwd: realpathSync(path.join(tmp.path, "src")) }])),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects a workdir that stops being a directory during approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const workdir = path.join(tmp.path, "src")
        afterPermission = (input) =>
          input.action === "bash"
            ? Effect.promise(async () => {
                await fs.rm(workdir, { recursive: true })
                await fs.writeFile(workdir, "not a directory")
              }).pipe(Effect.orDie)
            : Effect.void
        return Effect.promise(() => fs.mkdir(workdir)).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => executeTool(registry, call({ command: "pwd", workdir: "src" }))),
          ),
          Effect.andThen(
            Effect.sync(() => {
              expect(spawns).toEqual([])
              expect(assertions.map((input) => input.action)).toEqual(["bash"])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  if (process.platform !== "win32") {
    it.live("executes a real shell command through AppProcess", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withTool(
            tmp.path,
            (registry) => settleTool(registry, call({ command: "printf core-bash" })),
            LayerNode.compile(AppProcess.node),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                expect(settled.result).toEqual({
                  type: "content",
                  value: [
                    { type: "text", text: "core-bash" },
                    { type: "text", text: "Command exited with code 0." },
                  ],
                })
                expect(settled.output?.structured).toMatchObject({
                  exit: 0,
                })
                expect(settled.output?.structured).not.toHaveProperty("output")
                expect(progressEvents()).toEqual([])
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )

    it.live("emits bounded progress checkpoints while a real command runs", () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => {
          reset()
          return withTool(
            tmp.path,
            (registry) =>
              settleTool(registry, call({ command: "printf 'alpha\\n'; sleep 1.1; printf 'beta\\n'" })),
            LayerNode.compile(AppProcess.node),
          ).pipe(
            Effect.andThen((settled) =>
              Effect.sync(() => {
                const checkpoints = progressEvents()
                expect(checkpoints.length).toBeGreaterThanOrEqual(1)
                const first = checkpoints[0]?.data
                expect(first).toMatchObject({
                  sessionID,
                  assistantMessageID: toolIdentity.assistantMessageID,
                  callID: "call-bash",
                  structured: { truncated: false },
                })
                expect(String((first?.content as Array<{ text?: string }>)?.[0]?.text)).toContain("alpha")
                expect(settled.output?.content[0]).toEqual({ type: "text", text: "alpha\nbeta\n" })
                expect(settled.output?.structured).toMatchObject({ exit: 0, truncated: false })
              }),
            ),
          )
        },
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  it.live("approves an explicit external workdir before bash execution", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        return withTool(active.path, (registry) =>
          executeTool(registry, call({ command: "pwd", workdir: outside.path })),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", "bash"])
              expect(assertions[0]).toMatchObject({
                resources: [path.join(realpathSync(outside.path), "*").replaceAll("\\", "/")],
              })
              expect(spawns).toHaveLength(1)
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not execute after external-directory or bash denial", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          reset()
          denyAction = "external_directory"
          yield* withTool(active.path, (registry) =>
            executeTool(registry, call({ command: "pwd", workdir: outside.path })),
          )
          expect(assertions.map((item) => item.action)).toEqual(["external_directory"])
          expect(spawns).toEqual([])

          reset()
          denyAction = "bash"
          yield* withTool(active.path, (registry) => executeTool(registry, call({ command: "pwd" })))
          expect(assertions.map((item) => item.action)).toEqual(["bash"])
          expect(spawns).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("reports external command arguments as advisory warnings without enforcing approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        denyAction = "external_directory"
        const target = path.join(outside.path, "secret.txt")
        return withTool(active.path, (registry) => settleTool(registry, call({ command: `cat ${target}` }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(assertions.map((item) => item.action)).toEqual(["bash"])
              expect(spawns).toHaveLength(1)
              expect(settled.output?.structured).toMatchObject({
                truncated: false,
              })
              expect(settled.output?.structured).not.toHaveProperty("warnings")
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Warnings:"),
              })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("keeps non-zero exits useful", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        spawnResult = { ...spawnResult, exitCode: 7, output: Buffer.from("HEAD full output TAIL") }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "false" }, "call-overflow"))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Command exited with code 7"),
              })
              expect(settled.output?.structured).toMatchObject({
                exit: 7,
                truncated: false,
              })
              expect(settled.output?.content[0]).toEqual({ type: "text", text: "HEAD full output TAIL" })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("surfaces bounded process-capture truncation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        spawnResult = { ...spawnResult, output: Buffer.alloc(BashTool.MAX_CAPTURE_BYTES + 16, "a") }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "verbose" }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.structured).toMatchObject({ truncated: true })
              expect(settled.output?.content[0]).toMatchObject({
                type: "text",
                text: expect.stringContaining("output capture truncated"),
              })
              expect(settled.output?.structured).not.toHaveProperty("resource")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("returns a useful timeout settlement", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        spawnHang = true
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "sleep 60", timeout: 20 }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              expect(settled.output?.content[1]).toMatchObject({
                type: "text",
                text: expect.stringContaining("Command timed out"),
              })
              expect(settled.output?.structured).toMatchObject({
                timeout: true,
                truncated: false,
              })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps partial stdout when the command times out after producing output", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        spawnHang = true
        spawnResult = { ...spawnResult, output: Buffer.from("partial line before hang\n") }
        return withTool(tmp.path, (registry) => settleTool(registry, call({ command: "sleep 60", timeout: 50 }))).pipe(
          Effect.andThen((settled) =>
            Effect.sync(() => {
              const texts = (settled.output?.content ?? [])
                .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
                .map((c) => c.text)
              expect(texts.some((t) => t.includes("partial line before hang"))).toBe(true)
              expect(texts.some((t) => t.includes("timed out") || t.includes("timeout"))).toBe(true)
              expect(settled.output?.structured).toMatchObject({ timeout: true })
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("converts interrupt into a truncated settlement with captured output", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        spawnHang = true
        spawnResult = { ...spawnResult, output: Buffer.from("partial before cancel\n") }
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const fiber = yield* settleTool(registry, call({ command: "sleep 60", timeout: 30_000 })).pipe(
              Effect.forkChild,
            )
            yield* Effect.sleep("200 millis")
            yield* Fiber.interrupt(fiber)
            const exit = yield* Fiber.await(fiber)
            expect(Exit.isFailure(exit)).toBe(true)
            const success = published.filter((event) => event.type === SessionEvent.Tool.Success.type)
            expect(success.length).toBeGreaterThan(0)
            expect(JSON.stringify(success.at(-1))).toContain("partial before cancel")
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

test("bash execute uses exec-policy classify/decide and BackgroundJob", async () => {
  const source = await fs.readFile(new URL("../src/tool/bash.ts", import.meta.url), "utf8")
  expect(source).toContain("execPolicy.decideCommand")
  expect(source).toContain("jobs.start")
  expect(source).toContain("sandbox.wrapSpawn")
  expect(source).not.toContain("TODO: Port tree-sitter bash")
})
