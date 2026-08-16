import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { formatJobResult, notifyJobFinished } from "@opencode-ai/core/session/job-complete"
import { SessionRuntime } from "@opencode-ai/core/session/runtime"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "../lib/effect"

const sessionID = SessionSchema.ID.make("ses_job_complete")

const bashInfo = (status: BackgroundJob.Status, extra?: Partial<BackgroundJob.Info>): BackgroundJob.Info => ({
  id: "job_complete_1",
  type: "bash",
  status,
  started_at: Date.now(),
  output: "hello from job",
  metadata: { sessionId: sessionID, exit: 0, background: true },
  ...extra,
})

describe("job completion admit", () => {
  test("formats a bounded job-result envelope", () => {
    const text = formatJobResult(bashInfo("completed"))
    expect(text).toContain('<job-result jobID="job_complete_1" status="completed" exit="0">')
    expect(text).toContain("hello from job")
    expect(text).toContain("</job-result>")
  })

  const it = testEffect(Layer.empty)

  it.live("uses resume: false and does not wake a user_abort terminal", () =>
    Effect.gen(function* () {
      const prompts: Array<{ resume?: boolean; text: string }> = []
      const wakes: string[] = []
      const session = Layer.succeed(
        SessionV2.Service,
        {
          prompt: (input: { resume?: boolean; prompt: { text: string } }) =>
            Effect.sync(() => {
              prompts.push({ resume: input.resume, text: input.prompt.text })
              return { admittedSeq: 1 }
            }),
        } as unknown as SessionV2.Interface,
      )
      const execution = Layer.succeed(
        SessionExecution.Service,
        SessionExecution.Service.of({
          active: Effect.succeed(new Set()),
          resume: () => Effect.void,
          wake: (id) =>
            Effect.sync(() => {
              wakes.push(String(id))
            }),
          interrupt: () => Effect.void,
        }),
      )
      yield* Effect.gen(function* () {
        const runtime = yield* SessionRuntime.Service
        const inst = yield* runtime.getOrCreate(sessionID)
        yield* inst.terminal.request("user_abort")
        yield* notifyJobFinished(bashInfo("completed"))
        expect(prompts.length).toBe(1)
        expect(prompts[0]?.resume).toBe(false)
        expect(prompts[0]?.text).toContain("job_complete_1")
        expect(wakes).toEqual([])
        expect((yield* inst.terminal.snapshot).reason).toBe("user_abort")
      }).pipe(Effect.provide(Layer.mergeAll(session, execution, SessionRuntime.layerForTest)))
    }),
  )

  it.live("does not wake a hard_timeout terminal", () =>
    Effect.gen(function* () {
      const wakes: string[] = []
      const session = Layer.succeed(
        SessionV2.Service,
        {
          prompt: (input: { resume?: boolean; prompt: { text: string } }) =>
            Effect.sync(() => ({ admittedSeq: 1, resume: input.resume })),
        } as unknown as SessionV2.Interface,
      )
      const execution = Layer.succeed(
        SessionExecution.Service,
        SessionExecution.Service.of({
          active: Effect.succeed(new Set()),
          resume: () => Effect.void,
          wake: (id) =>
            Effect.sync(() => {
              wakes.push(String(id))
            }),
          interrupt: () => Effect.void,
        }),
      )
      yield* Effect.gen(function* () {
        const runtime = yield* SessionRuntime.Service
        const inst = yield* runtime.getOrCreate(sessionID)
        yield* inst.terminal.request("hard_timeout")
        yield* notifyJobFinished(bashInfo("completed"))
        expect(wakes).toEqual([])
        expect((yield* inst.terminal.snapshot).reason).toBe("hard_timeout")
      }).pipe(Effect.provide(Layer.mergeAll(session, execution, SessionRuntime.layerForTest)))
    }),
  )

  it.live("wakes when the session is not hard-aborted", () =>
    Effect.gen(function* () {
      const wakes: string[] = []
      const session = Layer.succeed(
        SessionV2.Service,
        {
          prompt: () => Effect.succeed({ admittedSeq: 1 }),
        } as unknown as SessionV2.Interface,
      )
      const execution = Layer.succeed(
        SessionExecution.Service,
        SessionExecution.Service.of({
          active: Effect.succeed(new Set()),
          resume: () => Effect.void,
          wake: (id) =>
            Effect.sync(() => {
              wakes.push(String(id))
            }),
          interrupt: () => Effect.void,
        }),
      )
      yield* notifyJobFinished(bashInfo("completed")).pipe(
        Effect.provide(Layer.mergeAll(session, execution, SessionRuntime.layerForTest)),
      )
      expect(wakes).toEqual([sessionID])
    }),
  )

  it.live("does not notify type=task jobs", () =>
    Effect.gen(function* () {
      const prompts: unknown[] = []
      const session = Layer.succeed(
        SessionV2.Service,
        {
          prompt: () =>
            Effect.sync(() => {
              prompts.push("called")
              return { admittedSeq: 1 }
            }),
        } as unknown as SessionV2.Interface,
      )
      yield* notifyJobFinished(bashInfo("completed", { type: "task" })).pipe(Effect.provide(session))
      expect(prompts).toEqual([])
    }),
  )
})
