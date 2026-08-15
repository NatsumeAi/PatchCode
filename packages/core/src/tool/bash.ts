export * as BashTool from "./bash"

import path from "path"
import { ToolFailure, type ToolOutput } from "@opencode-ai/llm"
import { Cause, DateTime, Duration, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { AppProcess } from "../process"
import { PermissionV2 } from "../permission"
import { ToolOutputStore } from "../tool-output-store"
import { PositiveInt } from "../schema"
import { SessionEvent } from "../session/event"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "bash"
export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000
export const MAX_TIMEOUT_MS = 10 * 60 * 1_000
export const MAX_CAPTURE_BYTES = 1024 * 1024
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
})

const StructuredOutput = Schema.Struct({
  exit: Schema.Number.pipe(Schema.optional),
  truncated: Schema.Boolean,
  timeout: Schema.Boolean.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  output: Schema.String,
  warnings: Schema.Array(Schema.String).pipe(Schema.optional),
})

type Output = typeof Output.Type

const defaultShell = () => (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")

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
 * Minimal V2 core shell boundary. Keep parity debt visible without pulling the
 * legacy shell runtime into core.
 */
// TODO: Port tree-sitter bash / PowerShell parser-based approval reduction.
// TODO: Port BashArity reusable command-prefix approvals.
// TODO: Replace token-based command-argument external-directory advisories with parser-based detection.
// TODO: Restore PowerShell and cmd-specific invocation/path handling on Windows.
// TODO: Add plugin shell.env environment augmentation once V2 plugin hooks exist.
// TODO: Persist background job status and define restart recovery before exposing remote observation.
// TODO: Re-add model-facing background launch only with owner-bound get/wait/cancel tools and completion delivery.
// TODO: Add HTTP background-job observation only after durable status, restart recovery, and authorization are defined.
// TODO: Revisit process-group cleanup and platform coverage with shell-specific tests if current AppProcess semantics do not fully cover it.
// TODO: Revisit binary output handling if stdout/stderr decoding is text-only.
// TODO: Stream full shell output into managed storage while retaining only a bounded in-memory preview.

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
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const resources = yield* ToolOutputStore.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description: `Execute one shell command string with the host user's filesystem, process, and network authority. The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. Timeout values are milliseconds (default: ${DEFAULT_TIMEOUT_MS}; maximum: ${MAX_TIMEOUT_MS}). Uses the configured shell when set; otherwise uses /bin/sh on POSIX and COMSPEC or cmd.exe on Windows.`,
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            truncated: output.truncated,
            ...(output.exit === undefined ? {} : { exit: output.exit }),
            ...(output.timeout === undefined ? {} : { timeout: output.timeout }),
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
              const target = yield* mutation.resolve({ path: input.workdir ?? ".", kind: "directory" })
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
              yield* permission.assert({
                action: name,
                resources: [input.command],
                save: [input.command],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })

              if ((yield* fs.stat(target.canonical)).type !== "Directory")
                return yield* Effect.fail(new Error(`Working directory is not a directory: ${target.canonical}`))

              const entries = yield* config.entries()
              const shell =
                Object.assign({}, ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info] : [])))
                  .shell ?? defaultShell()
              const command = ChildProcess.make(input.command, [], {
                cwd: target.canonical,
                shell,
                stdin: "ignore",
                detached: process.platform !== "win32",
                forceKillAfter: Duration.seconds(3),
              })
              const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS
              const collect = Effect.scoped(
                Effect.gen(function* () {
                  const handle = yield* appProcess.spawn(command)
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
              const settled = yield* Effect.uninterruptibleMask((restore) =>
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
                      }
                    }
                    const output = settled.buffer.toString("utf8") || "(no output)"
                    const notice = settled.truncated ? "[output capture truncated at the in-memory safety limit]" : undefined
                    return {
                      exit: settled.exitCode,
                      output: notice ? `${output}\n\n${notice}` : output,
                      truncated: settled.truncated === true,
                      ...(warnings.length ? { warnings } : {}),
                    }
                  }),
                ),
              )
              return settled
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
    Config.node,
    PermissionV2.node,
    EventV2.node,
    ToolOutputStore.node,
  ],
})
