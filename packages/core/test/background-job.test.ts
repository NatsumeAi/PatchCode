import { describe, expect } from "bun:test"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { BackgroundJobTable } from "@opencode-ai/core/background-job/sql"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Layer, Scope } from "effect"
import { it } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"
import path from "path"

const jobsLayer = LayerNode.compile(BackgroundJob.node)

describe("BackgroundJob", () => {
  it.live("tracks process-local work through explicit observation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { durable: false },
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job).toMatchObject({ type: "test", status: "running", metadata: { durable: false } })
      expect(yield* jobs.wait({ id: job.id, timeout: 0 })).toMatchObject({
        timedOut: true,
        info: { status: "running" },
      })

      yield* Deferred.succeed(latch, undefined)
      expect(yield* jobs.wait({ id: job.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("publishes jobs before starting immediately settling work", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) => {
        const id = `job_immediate_start_${index}`
        return Effect.gen(function* () {
          const job = yield* jobs.start({
            id,
            type: "test",
            run: jobs
              .get(id)
              .pipe(
                Effect.flatMap((info) =>
                  info?.status === "running"
                    ? Effect.succeed(`done-${index}`)
                    : Effect.fail("job started before publish"),
                ),
              ),
          })

          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `done-${index}` },
          })
        })
      })
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("increments pending work before starting immediately settling extensions", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service

      yield* Effect.forEach(Array.from({ length: 100 }), (_, index) =>
        Effect.gen(function* () {
          const first = yield* Deferred.make<void>()
          const job = yield* jobs.start({
            type: "test",
            run: Deferred.await(first).pipe(Effect.as(`first-${index}`)),
          })

          expect(yield* jobs.extend({ id: job.id, run: Effect.succeed(`second-${index}`) })).toBe(true)
          expect((yield* jobs.get(job.id))?.status).toBe("running")

          yield* Deferred.succeed(first, undefined)
          expect(yield* jobs.wait({ id: job.id })).toMatchObject({
            timedOut: false,
            info: { status: "completed", output: `second-${index}` },
          })
        }),
      )
    }).pipe(Effect.provide(jobsLayer)),
  )

  it.live("interrupts live work without promising settlement after the owning process-local scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.make.pipe(Scope.provide(scope))
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      yield* Scope.close(scope, Exit.void)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      // The abandoned in-memory registry is not a durable observation channel.
      expect((yield* jobs.get(job.id))?.status).toBe("running")
    }),
  )

  it.live("persists running rows to SQL and reaps stale after crash", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const filename = path.join(tmp.path, "jobs.sqlite")
      const layer = Layer.mergeAll(LayerNode.compile(BackgroundJob.node), Database.layerFromPath(filename))

      // Spawn live job → durable row running + complete.
      yield* Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const latch = yield* Deferred.make<void>()
        const job = yield* jobs.start({
          id: "job_durable_1",
          type: "test",
          metadata: { sessionId: "ses_parent" },
          run: Deferred.await(latch).pipe(Effect.as("done")),
        })
        const db = (yield* Database.Service).db
        const row = yield* db
          .select()
          .from(BackgroundJobTable)
          .where(eq(BackgroundJobTable.id, job.id))
          .get()
          .pipe(Effect.orDie)
        expect(row?.status).toBe("running")
        expect(row?.session_id).toBe("ses_parent")
        expect(typeof row?.heartbeat_at).toBe("number")
        yield* Deferred.succeed(latch, undefined)
        expect(yield* jobs.wait({ id: job.id })).toMatchObject({
          timedOut: false,
          info: { status: "completed", output: "done" },
        })
        const done = yield* db
          .select()
          .from(BackgroundJobTable)
          .where(eq(BackgroundJobTable.id, job.id))
          .get()
          .pipe(Effect.orDie)
        expect(done?.status).toBe("completed")
      }).pipe(Effect.provide(layer), Effect.scoped)

      // Simulate crash: insert stale running row, construct make → reaped.
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const staleAt = Date.now() - BackgroundJob.STALE_JOB_MS - 60_000
        yield* db
          .insert(BackgroundJobTable)
          .values({
            id: "job_stale_crash",
            type: "test",
            status: "running",
            started_at: staleAt,
            heartbeat_at: staleAt,
            session_id: "ses_x",
          })
          .run()
          .pipe(Effect.orDie)
        yield* BackgroundJob.make
        const row = yield* db
          .select()
          .from(BackgroundJobTable)
          .where(eq(BackgroundJobTable.id, "job_stale_crash"))
          .get()
          .pipe(Effect.orDie)
        expect(row?.status).toBe("error")
        expect(row?.error).toBe("stale-after-crash")

        const freshAt = Date.now()
        yield* db
          .insert(BackgroundJobTable)
          .values({
            id: "job_fresh_running",
            type: "test",
            status: "running",
            started_at: freshAt,
            heartbeat_at: freshAt,
          })
          .run()
          .pipe(Effect.orDie)
        yield* BackgroundJob.make
        const fresh = yield* db
          .select()
          .from(BackgroundJobTable)
          .where(eq(BackgroundJobTable.id, "job_fresh_running"))
          .get()
          .pipe(Effect.orDie)
        expect(fresh?.status).toBe("running")
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped)

      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }),
  )
})
