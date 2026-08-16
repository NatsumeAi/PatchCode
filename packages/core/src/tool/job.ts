export * as JobTool from "./job"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { BackgroundJob } from "../background-job"
import { makeLocationNode } from "../effect/app-node"
import { PositiveInt } from "../schema"
import { ToolOutputStore } from "../tool-output-store"
import { BashTool } from "./bash"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "job"

export const Input = Schema.Struct({
  action: Schema.Literals(["get", "wait", "kill"]).annotate({
    description: "get: snapshot; wait: block until the job settles; kill: cancel the process group",
  }),
  id: Schema.String.annotate({ description: "Background job id returned by bash with background: true" }),
  timeout: PositiveInt.check(Schema.isLessThanOrEqualTo(BashTool.MAX_TIMEOUT_MS))
    .pipe(Schema.optional)
    .annotate({ description: "Wait timeout in milliseconds (wait action only)" }),
})

const Output = Schema.Struct({
  jobID: Schema.String,
  status: Schema.String,
  output: Schema.String.pipe(Schema.optional),
  error: Schema.String.pipe(Schema.optional),
  exit: Schema.Number.pipe(Schema.optional),
})
export type Output = typeof Output.Type

const notFound = (id: string) => new ToolFailure({ message: `Job not found: ${id}` })

const snapshot = (info: BackgroundJob.Info): Output => {
  const raw = info.output ?? ""
  const output = raw.length > ToolOutputStore.MAX_BYTES ? raw.slice(-ToolOutputStore.MAX_BYTES) : raw
  const exit = info.metadata?.exit
  return {
    jobID: info.id,
    status: info.status,
    ...(output.length > 0 ? { output } : {}),
    ...(info.error ? { error: info.error } : {}),
    ...(typeof exit === "number" ? { exit } : {}),
  }
}

const owned = (info: BackgroundJob.Info | undefined, sessionID: string, id: string) => {
  if (!info || info.metadata?.sessionId !== sessionID) return Effect.fail(notFound(id))
  return Effect.succeed(info)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const jobs = yield* BackgroundJob.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Inspect, wait for, or kill a background bash job started in this session. Wrong-session ids are reported as not found.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: [
                `jobID=${output.jobID}`,
                `status=${output.status}`,
                ...(output.exit === undefined ? [] : [`exit=${output.exit}`]),
                ...(output.error ? [`error=${output.error}`] : []),
                ...(output.output ? [output.output] : []),
              ].join("\n"),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const info = yield* owned(yield* jobs.get(input.id), context.sessionID, input.id)
              if (input.action === "get") return snapshot(info)
              if (input.action === "kill") {
                const cancelled = yield* jobs.cancel(input.id)
                return snapshot(cancelled ?? info)
              }
              const waited = yield* jobs.wait({ id: input.id, timeout: input.timeout })
              if (!waited.info) return yield* Effect.fail(notFound(input.id))
              yield* owned(waited.info, context.sessionID, input.id)
              return snapshot(waited.info)
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({
                      message: error instanceof Error ? error.message : String(error),
                    }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/job",
  layer,
  deps: [ToolRegistry.node, BackgroundJob.node],
})
