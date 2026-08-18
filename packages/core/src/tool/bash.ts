export * as BashTool from "./bash"

import path from "path"
import { ToolFailure, type ToolOutput } from "@opencode-ai/llm"
import { Cause, Context, DateTime, Deferred, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../config"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { Identifier } from "../id/id"
import { LocationMutation } from "../location-mutation"
import { AppProcess } from "../process"
import { BackgroundJob } from "../background-job"
import { ExecPolicy } from "../exec-policy/service"
import { Permission } from "../permission"
import { Sandbox } from "../sandbox"
import { Shell } from "../shell"
import { Hooks } from "../hooks"
import { PlanGate } from "../session/plan-gate"
import { ToolOutputStore } from "../tool-output-store"
import { PositiveInt } from "../schema"
import { notifyJobFinished } from "../session/job-complete"
import { SessionEvent } from "../session/event"
import { BashPrompt } from "./bash-prompt"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024
/** Concurrent running `type=bash` jobs allowed per session. */
export const MAX_RUNNING_BASH = 8
export const BACKGROUND_NOTICE =
  "Started in the background. Use the job tool with this jobID. You will also be notified when it finishes."
/** Bounded checkpoint cadence for running-command progress events. */
export const PROGRESS_EVERY_MS = 500
/** Progress events carry only the tail window so durable events stay bounded. */
export const PROGRESS_TAIL_CHARS = 32 * 1024

export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" }),
  workdir: Schema.String.pipe(Schema.optional).annotate({
    description: "Working directory. Defaults to the active Location; relative paths resolve from that Location.",
  }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({
      description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS} and may not exceed ${MAX_TIMEOUT_MS}.`,
    }),
  background: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "If true, return a jobID immediately and keep the command running. Use the job tool to get, wait, or kill it.",
  }),
})

const StructuredOutput = Schema.Struct({
  exit: Schema.Number.pipe(Schema.optional),
  truncated: Schema.Boolean,
  timeout: Schema.Boolean.pipe(Schema.optional),
  jobID: Schema.String.pipe(Schema.optional),
  status: Schema.String.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

type Output = typeof Output.Type

const defaultShell = () => Shell.acceptable() ?? (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")

const spawnArgs = (shell: string, command: string, cwd: string) =>
  Shell.ps(shell) ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] : Shell.args(shell, command, cwd)

export interface Host {
  readonly env: (input: {
    readonly cwd: string
    readonly sessionID: string
    readonly callID: string
  }) => Effect.Effect<Record<string, string>>
}

export class HostService extends Context.Service<HostService, Host>()("@opencode/v2/BashTool.Host") {}

export const hostNode = makeGlobalNode({
  service: HostService,
  layer: Layer.succeed(
    HostService,
    HostService.of({
      env: () => Effect.succeed({}),
    }),
  ),
  deps: [],
})

const modelOutput = (output: Output) => {
  const warnings = output.warnings?.length
    ? `\n\nWarnings:\n${output.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : ""
  const prefix = `${warnings.trimStart()}${warnings ? "\n\n" : ""}`
  if (output.timeout) return `${prefix}Command timed out before completion.`
  if (output.exit === undefined) return `${prefix}Command interrupted.`
  return `${prefix}Command exited with code ${output.exit}.`
}

/**
 * V2 core shell. Parser-based approval lives in exec-policy (classify/decide).
 * Background jobs persist via BackgroundJob; leftover pids are reaped on boot.
 */

const shellTokens = (command: string) => command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2")
const externalCommandDirectories = Effect.fn("BashTool.externalCommandDirectories")(function* (
  fs: FSUtil.Interface,
  command: string,
  cwd: string,
) {
  const directories = new Set<string>()
  for (const token of shellTokens(command)) {
    const value = unquote(token).replace(/[;,|&]+$/, "")
    if (!path.isAbsolute(value)) continue
    const resolved = yield* fs.resolve(value)
    if (FSUtil.contains(cwd, resolved)) continue
    directories.add(yield* fs.resolve(path.dirname(resolved)))
  }
  return [...directories]
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const jobs = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const execPolicy = yield* ExecPolicy.Service
    const sandbox = yield* Sandbox.Service
    const events = yield* EventV2.Service
    const resources = yield* ToolOutputStore.Service
    const capturedHost = yield* Effect.serviceOption(HostService)
    const originEntries = yield* config.entries()
    const originShell = Shell.acceptable(Config.latest(originEntries, "shell")) ?? defaultShell()
    const limits = yield* resources.limits()
    const description = BashPrompt.render(Shell.name(originShell), process.platform, limits, DEFAULT_TIMEOUT_MS)

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            truncated: output.truncated,
            ...(output.exit === undefined ? {} : { exit: output.exit }),
            ...(output.timeout === undefined ? {} : { timeout: output.timeout }),
            ...(output.jobID === undefined ? {} : { jobID: output.jobID }),
            ...(output.status === undefined ? {} : { status: output.status }),
          }),
          toModelOutput: ({ output }) => [
            { type: "text", text: output.output },
            { type: "text", text: modelOutput(output) },
          ],
          execute: (input, context) => {
            const partial = {
              chunks: [] as Uint8Array[],
              truncated: false,
            }
            let published = false
            const publishPartial = Effect.uninterruptible(
              Effect.gen(function* () {
                if (published) return
                published = true
                const output = Buffer.concat(partial.chunks).toString("utf8") || "(no output)"
                const toolOutput = {
                  structured: { truncated: true },
                  content: [
                    { type: "text" as const, text: output },
                    { type: "text" as const, text: modelOutput({ output, truncated: true }) },
                  ],
                } satisfies ToolOutput
                const bounded = yield* resources.bound({
                  sessionID: context.sessionID,
                  toolCallID: context.toolCallID,
                  output: toolOutput,
                })
                yield* events.publish(SessionEvent.Tool.Success, {
                  sessionID: context.sessionID,
                  timestamp: yield* DateTime.now,
                  assistantMessageID: context.assistantMessageID,
                  callID: context.toolCallID,
                  structured: bounded.output.structured as Record<string, unknown>,
                  content: bounded.output.content,
                  ...(bounded.outputPaths.length > 0 ? { outputPaths: [...bounded.outputPaths] } : {}),
                  provider: { executed: false },
                })
              }).pipe(Effect.catchCause(() => Effect.void)),
            )
            return Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({
                path: input.workdir ?? ".",
                kind: "directory",
                sessionID: context.sessionID,
              })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              const warnings = (yield* externalCommandDirectories(fs, input.command, target.canonical)).map(
                (directory) =>
                  `Command argument references external directory ${path.join(directory, "*").replaceAll("\\", "/")}. Bash runs with host-user filesystem, process, and network authority; this scan is advisory only.`,
              )

              const entries = yield* config.entries()
              const shell = Shell.acceptable(Config.latest(entries, "shell")) ?? defaultShell()
              const extraEnv = Option.isSome(capturedHost)
                ? yield* capturedHost.value.env({
                    cwd: target.canonical,
                    sessionID: context.sessionID,
                    callID: context.toolCallID,
                  })
                : {}
              const spawnOpts = {
                cwd: target.canonical,
                stdin: "ignore" as const,
                detached: process.platform !== "win32",
                forceKillAfter: Duration.seconds(3),
                ...(Object.keys(extraEnv).length > 0 ? { env: extraEnv, extendEnv: true as const } : {}),
              }
              const resolved = yield* sandbox.resolve(context.sessionID)

              // Frozen execute chain:
              // classify → decide → PlanGate → PreToolUse → Permission → wrapSpawn → BackgroundJob
              // W2 deny never reaches PreToolUse. Settle skips bash PreToolUse so this is the only dispatch.
              const decision = yield* execPolicy.decideCommand(input.command, shell, {
                sandboxProfile: resolved.name,
              })
              const resources = decision.prefixes.map((prefix) => prefix.join(" "))
              yield* PlanGate.assertMutation({
                sessionID: context.sessionID,
                kind: "bash",
                command: input.command,
                shell,
              })
              const denyTool = Effect.fail(
                new ToolFailure({ message: "The user rejected permission to use this specific tool call." }),
              )
              if (decision.effect === "deny") return yield* denyTool
              // PreToolUse once, after classify/decide (W2 deny never reaches here) and before Permission.
              const hooksOpt = yield* Effect.serviceOption(Hooks.Service)
              if (Option.isSome(hooksOpt)) {
                const hooked = yield* hooksOpt.value.dispatch({
                  event: "PreToolUse",
                  sessionID: context.sessionID,
                  toolName: name,
                  toolInput: input,
                })
                if (hooked._tag === "Deny")
                  return yield* new ToolFailure({ message: `Hook denied: ${hooked.reason}` })
              }
              if (decision.effect === "ask") {
                yield* permission.assertPolicyAsk({
                  action: name,
                  resources,
                  save: resources,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                }).pipe(Effect.catchTag("Permission.BlockedError", () => denyTool))
              } else {
                yield* permission.assert({
                  action: name,
                  resources,
                  save: resources,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                }).pipe(Effect.catchTag("Permission.BlockedError", () => denyTool))
              }

              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))

              const wrapped =
                resolved.name === "off"
                  ? undefined
                  : yield* sandbox.wrapSpawn({
                      class: "workspace-child",
                      command: shell,
                      args: spawnArgs(shell, input.command, target.canonical),
                      cwd: target.canonical,
                      sessionID: context.sessionID,
                    })
              const command = wrapped
                ? ChildProcess.make(wrapped.command, wrapped.args, spawnOpts)
                : ChildProcess.make(input.command, [], {
                    ...spawnOpts,
                    shell,
                  })
              const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
              if (input.background === true) {
                const running = (yield* jobs.list()).filter(
                  (job) =>
                    job.type === "bash" &&
                    job.status === "running" &&
                    job.metadata?.sessionId === context.sessionID,
                )
                if (running.length >= MAX_RUNNING_BASH) {
                  return yield* Effect.fail(new ToolFailure({ message: "Job.Busy" }))
                }
              }

              const spawned = yield* Deferred.make<void>()
              const jobID = Identifier.ascending("job")
              const backgroundLaunch = input.background === true
              const collect = Effect.scoped(
                Effect.gen(function* () {
                  const handle = yield* appProcess.spawn(command)
                  const pid = Number((handle as { pid?: number }).pid)
                  if (Number.isFinite(pid) && pid > 0) {
                    yield* jobs.patch(jobID, { pid, pgid: pid })
                  }
                  yield* Deferred.succeed(spawned, undefined)
                  const decoder = new TextDecoder("utf-8")
                  let bytes = 0
                  let tail = ""
                  let lastCheckpoint = Date.now()
                  const publishProgress = Effect.fnUntraced(function* (text: string) {
                    if (text.length === 0) return
                    yield* events.publish(SessionEvent.Tool.Progress, {
                      sessionID: context.sessionID,
                      assistantMessageID: context.assistantMessageID,
                      timestamp: yield* DateTime.now,
                      callID: context.toolCallID,
                      structured: { truncated: partial.truncated },
                      content: [{ type: "text" as const, text }],
                    })
                  })
                  yield* Effect.forkScoped(
                    Effect.forever(
                      Effect.sleep(Duration.millis(PROGRESS_EVERY_MS)).pipe(
                        Effect.andThen(Effect.suspend(() => publishProgress(tail))),
                      ),
                    ),
                  )
                  yield* handle.all.pipe(
                    Stream.mapEffect((chunk: Uint8Array) =>
                      Effect.gen(function* () {
                        const remaining = MAX_CAPTURE_BYTES - bytes
                        if (remaining > 0)
                          partial.chunks.push(remaining >= chunk.length ? chunk : chunk.slice(0, remaining))
                        bytes += chunk.length
                        partial.truncated = partial.truncated || bytes > MAX_CAPTURE_BYTES
                        const text = decoder.decode(chunk, { stream: true })
                        if (text.length === 0) return
                        tail = (tail + text).slice(-PROGRESS_TAIL_CHARS)
                        const now = Date.now()
                        if (now - lastCheckpoint < PROGRESS_EVERY_MS) return
                        lastCheckpoint = now
                        yield* publishProgress(tail)
                      }),
                    ),
                    Stream.runDrain,
                  )
                  // Flush incomplete multi-byte sequences held by the streaming decoder.
                  const flushed = decoder.decode()
                  if (flushed.length > 0) tail = (tail + flushed).slice(-PROGRESS_TAIL_CHARS)
                  const exitCode = yield* handle.exitCode
                  return {
                    buffer: Buffer.concat(partial.chunks),
                    truncated: partial.truncated,
                    exitCode,
                  }
                }),
              )
              const run = Effect.uninterruptibleMask((restore) =>
                restore(
                  Effect.timeoutOrElse(collect, {
                    duration: Duration.millis(timeout),
                    orElse: () =>
                      Effect.succeed({
                        buffer: Buffer.concat(partial.chunks),
                        truncated: partial.truncated,
                        exitCode: undefined as number | undefined,
                        timedOut: true as const,
                      }),
                  }),
                ).pipe(
                  // exit/flatMap must wrap restore(), not sit inside it: fiber
                  // interrupt never yields an Exit from restore(effect.exit).
                  Effect.exit,
                  Effect.flatMap((exit) => {
                    if (exit._tag === "Success") return Effect.succeed(exit.value)
                    // Killing the process often surfaces as a stream/platform
                    // error rather than an interrupt; keep the partial buffer.
                    if (Cause.hasInterrupts(exit.cause) || partial.chunks.length > 0) {
                      return Effect.succeed({
                        buffer: Buffer.concat(partial.chunks),
                        truncated: true,
                        exitCode: undefined as number | undefined,
                      })
                    }
                    return Effect.failCause(exit.cause)
                  }),
                  Effect.map((settled) => {
                    if ("timedOut" in settled && settled.timedOut) {
                      const captured = settled.buffer.toString("utf8").trimEnd()
                      const notice = `Command exceeded timeout of ${timeout} ms. Retry with a larger timeout if the command is expected to take longer.`
                      return {
                        output: captured.length > 0 ? `${captured}\n\n${notice}` : notice,
                        truncated: settled.truncated === true,
                        timeout: true,
                        ...(warnings.length ? { warnings } : {}),
                      } satisfies Output
                    }
                    const output = settled.buffer.toString("utf8") || "(no output)"
                    const notice = settled.truncated ? "[output capture truncated at the in-memory safety limit]" : undefined
                    return {
                      exit: settled.exitCode,
                      output: notice ? `${output}\n\n${notice}` : output,
                      truncated: settled.truncated === true,
                      ...(warnings.length ? { warnings } : {}),
                    } satisfies Output
                  }),
                  Effect.tap((settled) =>
                    jobs.patch(jobID, {
                      ...(settled.exit === undefined ? {} : { exit: settled.exit }),
                      truncated: settled.truncated,
                      ...(settled.timeout === undefined ? {} : { timeout: settled.timeout }),
                      ...(settled.warnings ? { warnings: settled.warnings } : {}),
                    }),
                  ),
                  Effect.tap((settled) =>
                    Effect.gen(function* () {
                      const live = yield* jobs.get(jobID)
                      if (live?.metadata?.background !== true && !backgroundLaunch) return
                      const status =
                        live?.status === "cancelled" || live?.status === "error" || live?.status === "completed"
                          ? live.status
                          : settled.timeout
                            ? "error"
                            : "completed"
                      yield* notifyJobFinished({
                        id: jobID,
                        type: "bash",
                        title: input.command.slice(0, 80),
                        status,
                        started_at: live?.started_at ?? Date.now(),
                        output: settled.output,
                        ...(live?.error ? { error: live.error } : {}),
                        metadata: {
                          sessionId: context.sessionID,
                          callID: context.toolCallID,
                          command: input.command,
                          background: true,
                          ...(settled.exit === undefined ? {} : { exit: settled.exit }),
                        },
                      })
                    }),
                  ),
                  Effect.map((settled) => settled.output),
                ),
              )
              const job = yield* jobs.start({
                id: jobID,
                type: "bash",
                title: input.command.slice(0, 80),
                metadata: {
                  sessionId: context.sessionID,
                  callID: context.toolCallID,
                  command: input.command,
                  ...(backgroundLaunch ? { background: true } : {}),
                },
                run: run.pipe(Effect.ensuring(Deferred.succeed(spawned, undefined))),
              })
              yield* Deferred.await(spawned)

              const launched = (): Output => ({
                jobID: job.id,
                status: "running",
                output: BACKGROUND_NOTICE,
                truncated: false,
              })

              if (backgroundLaunch) {
                const live = yield* jobs.get(job.id)
                const pid = Number(live?.metadata?.pid)
                // Freeze: pid/pgid required on a running row before return. If
                // spawn failed, ensuring still unblocks `spawned` — do not lie.
                if (live?.status === "running" && Number.isFinite(pid) && pid > 1) return launched()
              }

              const waitDone = jobs.wait({ id: job.id }).pipe(
                Effect.map((waited) => ({ tag: "done" as const, waited })),
              )
              const waitPromoted = jobs.waitForPromotion(job.id).pipe(
                Effect.catch(() => Effect.never),
                Effect.map((info) => ({ tag: "promoted" as const, info })),
              )
              const winner = yield* Effect.race(waitDone, waitPromoted)
              if (winner.tag === "promoted") return launched()
              const waited = winner.waited
              const info = waited.info
              if (!info) {
                return yield* Effect.fail(new Error("Background job disappeared before settlement"))
              }
              if (info.metadata?.background === true && info.status === "running") return launched()
              if (info.status === "error" && !info.output) {
                return yield* Effect.fail(new Error(info.error ?? "bash job failed"))
              }
              const meta = info.metadata ?? {}
              return {
                output: info.output || "(no output)",
                truncated: meta.truncated === true || info.status === "cancelled",
                ...(typeof meta.exit === "number" ? { exit: meta.exit } : {}),
                ...(meta.timeout === true ? { timeout: true } : {}),
                ...(Array.isArray(meta.warnings) ? { warnings: meta.warnings as string[] } : {}),
              } satisfies Output
            }).pipe(
              Effect.tap(() => Effect.sync(() => { published = true })),
              Effect.catchCause((cause) => {
                if (!Cause.hasInterrupts(cause)) return Effect.failCause(cause)
                const output = Buffer.concat(partial.chunks).toString("utf8") || "(no output)"
                return Effect.succeed({
                  output,
                  truncated: true,
                })
              }),
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                if (error instanceof PlanGate.Denied) return new ToolFailure({ message: error.message })
                const detail =
                  error instanceof Error && error.message
                    ? error.message
                    : typeof error === "object" && error && "message" in error
                      ? String((error as { message: unknown }).message)
                      : String(error)
                return new ToolFailure({
                  message: `Unable to execute command: ${input.command}${detail ? ` (${detail})` : ""}`,
                })
              }),
              // Fiber interrupt never lets catchCause/exit succeed; ensuring still
              // runs. Only publish when execute did not finish and we captured
              // output — permission/workdir failures must not become Success.
              Effect.ensuring(
                Effect.uninterruptible(
                  Effect.suspend(() => (published || partial.chunks.length === 0 ? Effect.void : publishPartial)),
                ),
              ),
            )
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/bash",
  layer,
  deps: [
    ToolRegistry.node,
    LocationMutation.node,
    FSUtil.node,
    AppProcess.node,
    BackgroundJob.node,
    Config.node,
    Permission.node,
    ExecPolicy.node,
    Sandbox.node,
    EventV2.node,
    ToolOutputStore.node,
    PlanGate.node,
    hostNode,
  ],
})
