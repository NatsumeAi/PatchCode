export * as BackgroundJob from "./background-job"

import { Cause, Clock, Context, DateTime, Deferred, Duration, Effect, Exit, Layer, Option, Scope, SynchronizedRef } from "effect"
import { eq } from "drizzle-orm"
import { Identifier } from "./id/id"
import { makeGlobalNode } from "./effect/app-node"
import { Database } from "./database/database"
import { BackgroundJobTable } from "./background-job/sql"
import { EventV2 } from "./event"
import { SessionEvent } from "./session/event"
import { SessionSchema } from "./session/schema"

export type Status = "running" | "completed" | "error" | "cancelled"

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  scope: Scope.Closeable
  token: object
  pending: number
  next: number
  output?: { sequence: number; text: string }
  tail: Deferred.Deferred<void>
  promoted: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  scope?: Scope.Closeable
}

type PromoteResult = {
  info?: Info
  promoted?: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
}

type StartResult = { info: Info } | { info: Info; scope: Scope.Closeable; token: object }

type ExtendResult =
  | { extended: false }
  | {
      extended: true
      previous: Deferred.Deferred<void>
      scope: Scope.Closeable
      tail: Deferred.Deferred<void>
      token: object
      sequence: number
    }

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  onPromote?: Effect.Effect<void>
  run: Effect.Effect<string, unknown>
}

export type ExtendInput = {
  id: string
  run: Effect.Effect<string, unknown>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

const PROMOTE_WAIT_TIMEOUT = Duration.minutes(30)

export class PromotionTimeoutError extends Error {
  readonly _tag = "PromotionTimeoutError" as const
  constructor(readonly jobID: string) {
    super(`Background job ${jobID} was not promoted within 30 minutes`)
    this.name = "PromotionTimeoutError"
  }
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly extend: (input: ExtendInput) => Effect.Effect<boolean>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly waitForPromotion: (id: string) => Effect.Effect<Info, PromotionTimeoutError>
  readonly promote: (id: string) => Effect.Effect<Info | undefined>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundJob") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Stale running jobs older than this are reaped as failed after crash (W3). */
export const STALE_JOB_MS = Duration.toMillis(PROMOTE_WAIT_TIMEOUT)
/** Live jobs refresh heartbeat this often so a 30m crash window is meaningful. */
const HEARTBEAT_INTERVAL = Duration.minutes(5)

/** Parent session for crash notify. Task hosts store parentSessionId + child sessionId. */
function sessionIdFrom(info: Info): string | undefined {
  const meta = info.metadata
  if (!meta) return undefined
  const parent = meta.parentSessionId ?? meta.parentSessionID ?? meta.parent_session_id
  if (typeof parent === "string" && parent.length > 0) return parent
  const child = meta.sessionId ?? meta.sessionID
  return typeof child === "string" && child.length > 0 ? child : undefined
}

/** Job ids this process is actually running — do not reap these as crash leftovers. */
const liveJobIds = new Set<string>()

function rowToInfo(row: typeof BackgroundJobTable.$inferSelect): Info {
  return {
    id: row.id,
    type: row.type,
    title: row.title ?? undefined,
    status: row.status as Status,
    started_at: row.started_at,
    completed_at: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    output: row.output ?? undefined,
    metadata: row.metadata ?? undefined,
  }
}

/**
 * Process-local fast path + SQLite durable ledger for crash recovery (W3).
 * Live work still runs in-memory; durable table is the source of truth across
 * restarts. When Database is unavailable (unit tests using bare `make`), falls
 * back to process-local only. Production `node` depends on Database so SQL is default.
 */
export const make = Effect.gen(function* () {
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    scope: yield* Scope.Scope,
  }
  const databaseOpt = yield* Effect.serviceOption(Database.Service)
  const db = Option.isSome(databaseOpt) ? databaseOpt.value.db : undefined
  const eventsOpt = yield* Effect.serviceOption(EventV2.Service)

  const touchDurable = (info: Info, heartbeat = true): Effect.Effect<void> => {
    if (!db) return Effect.void
    const now = Date.now()
    return db
      .insert(BackgroundJobTable)
      .values({
        id: info.id,
        type: info.type,
        status: info.status,
        title: info.title,
        session_id: sessionIdFrom(info),
        started_at: info.started_at,
        heartbeat_at: heartbeat ? now : info.started_at,
        completed_at: info.completed_at,
        error: info.error,
        output: info.output,
        metadata: info.metadata,
      })
      .onConflictDoUpdate({
        target: BackgroundJobTable.id,
        set: {
          type: info.type,
          status: info.status,
          title: info.title,
          session_id: sessionIdFrom(info),
          started_at: info.started_at,
          ...(heartbeat ? { heartbeat_at: now } : {}),
          completed_at: info.completed_at,
          error: info.error,
          output: info.output,
          metadata: info.metadata,
        },
      })
      .run()
      .pipe(
        Effect.orDie,
        Effect.asVoid,
        Effect.catch(() => Effect.void),
      )
  }

  const getDurable = (id: string): Effect.Effect<Info | undefined> => {
    if (!db) return Effect.succeed(undefined)
    return db
      .select()
      .from(BackgroundJobTable)
      .where(eq(BackgroundJobTable.id, id))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => (row ? rowToInfo(row) : undefined)),
        Effect.catch(() => Effect.succeed(undefined as Info | undefined)),
      )
  }

  /** Reap stale running rows left by a prior crash. Returns reaped infos. */
  const reapStale = (): Effect.Effect<Info[]> => {
    if (!db) return Effect.succeed([])
    const now = Date.now()
    return Effect.gen(function* () {
      // This process cannot inherit live work. Every leftover `running` row is
      // a prior-crash orphan (the 30m heartbeat is only for live extend).
      const leftover = yield* db
        .select()
        .from(BackgroundJobTable)
        .where(eq(BackgroundJobTable.status, "running"))
        .all()
        .pipe(Effect.orDie)
      const stale = leftover.filter((row) => !liveJobIds.has(row.id))
      const reaped: Info[] = []
      for (const row of stale) {
        yield* db
          .update(BackgroundJobTable)
          .set({ status: "error", completed_at: now, error: "stale-after-crash" })
          .where(eq(BackgroundJobTable.id, row.id))
          .run()
          .pipe(Effect.orDie)
        reaped.push(
          rowToInfo({
            ...row,
            status: "error",
            completed_at: now,
            error: "stale-after-crash",
          }),
        )
      }
      if (reaped.length > 0) {
        yield* Effect.logInfo("BackgroundJob.reapStale", { count: reaped.length }).pipe(Effect.ignore)
        if (Option.isSome(eventsOpt)) {
          const events = eventsOpt.value
          for (const row of stale) {
            const parent = row.session_id
            if (!parent) continue
            yield* events
              .publish(SessionEvent.Subagent.Failed, {
                timestamp: yield* DateTime.now,
                sessionID: SessionSchema.ID.make(parent),
                childSessionID: row.id,
                subagentType: row.type,
                error: "stale-after-crash",
                resumeFrom: row.id,
              })
              .pipe(Effect.ignore)
          }
        }
      }
      return reaped
    }).pipe(Effect.catch(() => Effect.succeed([] as Info[])))
  }

  // Run reap once at construction (best-effort).
  yield* reapStale()

  const settle = Effect.fn("BackgroundJob.settle")(function* (
    id: string,
    token: object,
    sequence: number,
    exit: Exit.Exit<string, unknown>,
  ) {
    yield* Effect.logInfo("BackgroundJob.settle", {
      id,
      success: Exit.isSuccess(exit),
    }).pipe(Effect.ignore)
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (job.token !== token) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const pending = job.pending - 1
      const output =
        Exit.isSuccess(exit) && (!job.output || sequence > job.output.sequence)
          ? { sequence, text: exit.value }
          : job.output
      if (Exit.isSuccess(exit) && pending > 0) {
        return [{}, new Map(jobs).set(id, { ...job, pending, output })]
      }
      const status: Exclude<Status, "running"> = Exit.isSuccess(exit)
        ? "completed"
        : Cause.hasInterruptsOnly(exit.cause)
          ? "cancelled"
          : "error"
      const next = {
        ...job,
        onPromote: undefined,
        pending: 0,
        output,
        info: {
          ...job.info,
          status,
          completed_at,
          ...(output ? { output: output.text } : {}),
          ...(Exit.isFailure(exit) ? { error: errorText(Cause.squash(exit.cause)) } : {}),
        },
      }
      return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.info) {
      if (result.info.status !== "running") liveJobIds.delete(id)
      yield* touchDurable(result.info, false)
    }
    if (result.scope) {
      yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
    }
    return result.info
  })

  const fork = Effect.fn("BackgroundJob.fork")(function* (
    scope: Scope.Scope,
    id: string,
    token: object,
    sequence: number,
    run: Effect.Effect<string, unknown>,
  ) {
    return yield* run.pipe(
      Effect.matchCauseEffect({
        onSuccess: (output) => settle(id, token, sequence, Exit.succeed(output)),
        onFailure: (cause) => settle(id, token, sequence, Exit.failCause(cause)),
      }),
      Effect.asVoid,
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

  const listDurable = (): Effect.Effect<Info[]> => {
    if (!db) return Effect.succeed([])
    return db
      .select()
      .from(BackgroundJobTable)
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map(rowToInfo)),
        Effect.catch(() => Effect.succeed([] as Info[])),
      )
  }

  const list: Interface["list"] = Effect.fn("BackgroundJob.list")(function* () {
    const live = Array.from((yield* SynchronizedRef.get(state.jobs)).values()).map(snapshot)
    const liveIds = new Set(live.map((j) => j.id))
    const durable = (yield* listDurable()).filter((row) => !liveIds.has(row.id))
    return [...live, ...durable].toSorted((a, b) => a.started_at - b.started_at)
  })

  const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (job) return snapshot(job)
    // After crash/reap, live map is empty — fall back to durable ledger.
    return yield* getDurable(id)
  })

  const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = input.id ?? Identifier.ascending("job")
        const started_at = yield* Clock.currentTimeMillis
        const done = yield* Deferred.make<Info>()
        const promoted = yield* Deferred.make<Info>()
        const tail = yield* Deferred.make<void>()
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs) {
            const existing = jobs.get(id)
            if (existing?.info.status === "running") {
              return [{ info: snapshot(existing) }, jobs] as readonly [StartResult, Map<string, Active>]
            }
            const scope = yield* Scope.fork(state.scope, "parallel")
            const token = {}
            const job = {
              info: {
                id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                started_at,
                metadata: input.metadata,
              },
              done,
              scope,
              token,
              pending: 1,
              next: 1,
              tail,
              promoted,
              onPromote: input.onPromote,
            }
            return [{ info: snapshot(job), scope, token }, new Map(jobs).set(id, job)] as readonly [
              StartResult,
              Map<string, Active>,
            ]
          }),
        )
        if ("scope" in result) {
          yield* fork(
            result.scope,
            id,
            result.token,
            0,
            restore(input.run).pipe(Effect.ensuring(Deferred.succeed(tail, undefined))),
          )
          if (db) {
            yield* Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep(HEARTBEAT_INTERVAL)
                const live = (yield* SynchronizedRef.get(state.jobs)).get(id)
                if (!live || live.info.status !== "running") return
                yield* touchDurable(snapshot(live), true)
              }
            }).pipe(Effect.ignore, Effect.forkIn(result.scope, { startImmediately: true }))
          }
        }
        liveJobIds.add(id)
        yield* touchDurable(result.info)
        return result.info
      }),
    )
  })

  const extend: Interface["extend"] = Effect.fn("BackgroundJob.extend")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const tail = yield* Deferred.make<void>()
        const result = yield* SynchronizedRef.modify(
          state.jobs,
          (jobs): readonly [ExtendResult, Map<string, Active>] => {
            const job = jobs.get(input.id)
            if (!job || job.info.status !== "running") return [{ extended: false }, jobs]
            return [
              { extended: true, previous: job.tail, scope: job.scope, tail, token: job.token, sequence: job.next },
              new Map(jobs).set(input.id, {
                ...job,
                pending: job.pending + 1,
                next: job.next + 1,
                tail,
              }),
            ]
          },
        )
        if (!result.extended) return false
        yield* fork(
          result.scope,
          input.id,
          result.token,
          result.sequence,
          Deferred.await(result.previous).pipe(
            Effect.andThen(restore(input.run)),
            Effect.ensuring(Deferred.succeed(result.tail, undefined)),
          ),
        )
        // Heartbeat on extend so long multi-step jobs are not reaped while live.
        const live = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
        if (live) yield* touchDurable(snapshot(live), true)
        return true
      }),
    )
  })

  const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
    if (!job) {
      // Crash recovery: job is gone from memory; return durable terminal/status.
      const durable = yield* getDurable(input.id)
      return durable ? { info: durable, timedOut: false } : { timedOut: false }
    }
    if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
    if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
    if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
    const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
    if (info._tag === "Some") return { info: info.value, timedOut: false }
    return { info: snapshot(job), timedOut: true }
  })

  const waitForPromotion: Interface["waitForPromotion"] = Effect.fn("BackgroundJob.waitForPromotion")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job || job.info.status !== "running") return yield* Effect.never
    if (job.info.metadata?.background === true) return snapshot(job)
    const promoted = yield* Deferred.await(job.promoted).pipe(
      Effect.timeoutOption(PROMOTE_WAIT_TIMEOUT),
    )
    if (promoted._tag === "Some") return promoted.value
    return yield* Effect.fail(new PromotionTimeoutError(id))
  })

  const promote: Interface["promote"] = Effect.fn("BackgroundJob.promote")(function* (id) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs) {
        const job = jobs.get(id)
        if (!job || job.info.status !== "running") return [{}, jobs] as readonly [PromoteResult, Map<string, Active>]
        if (job.info.metadata?.background === true)
          return [{ info: snapshot(job) }, jobs] as readonly [PromoteResult, Map<string, Active>]
        const next = {
          ...job,
          onPromote: undefined,
          info: {
            ...job.info,
            metadata: { ...job.info.metadata, background: true },
          },
        }
        return [
          { info: snapshot(next), onPromote: job.onPromote, promoted: job.promoted },
          new Map(jobs).set(id, next),
        ] as readonly [PromoteResult, Map<string, Active>]
      }),
    )
    if (result.info && result.promoted) yield* Deferred.succeed(result.promoted, result.info).pipe(Effect.ignore)
    if (result.info) yield* touchDurable(result.info, true)
    if (result.onPromote) yield* result.onPromote.pipe(Effect.ignore)
    return result.info
  })

  const cancel: Interface["cancel"] = Effect.fn("BackgroundJob.cancel")(function* (id) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const next = {
        ...job,
        onPromote: undefined,
        pending: 0,
        info: {
          ...job.info,
          status: "cancelled" as const,
          completed_at,
        },
      }
      return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.info) {
      if (result.info.status !== "running") liveJobIds.delete(id)
      yield* touchDurable(result.info, false)
    }
    if (result.scope) yield* Scope.close(result.scope, Exit.void)
    return result.info
  })

  return Service.of({ list, get, start, extend, wait, waitForPromotion, promote, cancel })
})

const layer = Layer.effect(Service, make)

/** Production node: Database required so crash durability is on by default. */
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
