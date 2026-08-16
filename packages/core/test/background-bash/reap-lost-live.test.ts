import { describe, expect } from "bun:test"
import { spawn } from "node:child_process"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { BackgroundJob } from "@opencode-ai/core/background-job"
import { BackgroundJobTable } from "@opencode-ai/core/background-job/sql"
import { Database } from "@opencode-ai/core/database/database"
import { tmpdir } from "../fixture/tmpdir"
import { it } from "../lib/effect"

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform === "win32")("reap leftover bash", () => {
  it.live("killpg leftover bash pid and marks lost-after-crash without inventing output", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const filename = path.join(tmp.path, "jobs.sqlite")
      const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
      const pid = child.pid
      expect(pid).toBeGreaterThan(1)
      yield* Effect.sleep(50)
      expect(alive(pid!)).toBe(true)

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db
          .insert(BackgroundJobTable)
          .values({
            id: "job_leftover_bash",
            type: "bash",
            status: "running",
            started_at: Date.now(),
            heartbeat_at: Date.now(),
            session_id: "ses_reap",
            metadata: { pid, pgid: pid, sessionId: "ses_reap", command: "sleep 30" },
          })
          .run()
          .pipe(Effect.orDie)
        const inserted = yield* db
          .select()
          .from(BackgroundJobTable)
          .where(eq(BackgroundJobTable.id, "job_leftover_bash"))
          .get()
          .pipe(Effect.orDie)
        expect(Number(inserted?.metadata?.pid ?? inserted?.metadata?.pgid)).toBe(pid)
        yield* BackgroundJob.make
        const deadline = Date.now() + 2000
        while (Date.now() < deadline) {
          try {
            process.kill(pid!, 0)
            yield* Effect.sleep(20)
          } catch {
            break
          }
        }
        expect(() => process.kill(pid!, 0)).toThrow()
        const row = yield* db
          .select()
          .from(BackgroundJobTable)
          .where(eq(BackgroundJobTable.id, "job_leftover_bash"))
          .get()
          .pipe(Effect.orDie)
        expect(row?.status).toBe("error")
        expect(row?.error).toBe("lost-after-crash")
        expect(row?.output == null || row.output === "").toBe(true)
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped)

      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }),
  )

  it.live("does not kill leftover type=task pids", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const filename = path.join(tmp.path, "jobs-task.sqlite")
      const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" })
      const pid = child.pid
      expect(pid).toBeGreaterThan(1)
      yield* Effect.sleep(50)

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db
          .insert(BackgroundJobTable)
          .values({
            id: "job_leftover_task",
            type: "task",
            status: "running",
            started_at: Date.now(),
            heartbeat_at: Date.now(),
            session_id: "ses_task",
            metadata: { pid, pgid: pid, sessionId: "ses_task" },
          })
          .run()
          .pipe(Effect.orDie)
        yield* BackgroundJob.make
        expect(alive(pid!)).toBe(true)
        const row = yield* db
          .select()
          .from(BackgroundJobTable)
          .where(eq(BackgroundJobTable.id, "job_leftover_task"))
          .get()
          .pipe(Effect.orDie)
        expect(row?.status).toBe("error")
        expect(row?.error).toBe("stale-after-crash")
      }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped)

      try {
        process.kill(-pid!, "SIGKILL")
      } catch {
        try {
          process.kill(pid!, "SIGKILL")
        } catch {
          // already gone
        }
      }
      yield* Effect.promise(() => tmp[Symbol.asyncDispose]())
    }),
  )
})
