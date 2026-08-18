export * as SubagentRegistry from "./subagent-registry"

import { Context, DateTime, Duration, Effect, Layer, Schedule, Schema, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Event } from "../event"
import { SessionEvent } from "./event"
import { SubagentLifecycle } from "./subagent-lifecycle"
import { SessionSchema } from "./schema"

const SubagentHeartbeatLost = SessionEvent.Subagent.HeartbeatLost

export const SubagentStatus = Schema.Literals(["pending", "active", "completed", "failed", "cancelled", "lost"])
export type SubagentStatus = typeof SubagentStatus.Type

export const SubagentRecord = Schema.Struct({
  childSessionID: SessionSchema.ID,
  parentSessionID: SessionSchema.ID,
  subagentType: Schema.String,
  status: SubagentStatus,
  createdAt: Schema.Number,
  startedAt: Schema.optional(Schema.Number),
  finishedAt: Schema.optional(Schema.Number),
  cancelToken: Schema.String,
  lastHeartbeatAt: Schema.Number,
  turnCount: Schema.Number,
  toolCallCount: Schema.Number,
  tokensUsed: Schema.Number,
  error: Schema.optional(Schema.String),
  resumeFrom: Schema.optional(Schema.String),
  address: Schema.String,
})
export type SubagentRecord = Schema.Schema.Type<typeof SubagentRecord>

export class InvalidTransition extends Schema.TaggedErrorClass<InvalidTransition>()(
  "Subagent.Registry.InvalidTransition",
  { childSessionID: Schema.String, from: SubagentStatus, to: SubagentStatus },
) {}

type RecordMap = Map<SessionSchema.ID, SubagentRecord>

const PENDING_TO: readonly SubagentStatus[] = ["active", "cancelled"]
const ACTIVE_TO: readonly SubagentStatus[] = ["completed", "failed", "cancelled", "lost"]
const TERMINAL: readonly SubagentStatus[] = ["completed", "failed", "cancelled", "lost"]

const isAllowed = (from: SubagentStatus, to: SubagentStatus): boolean => {
  if (from === "pending") return PENDING_TO.includes(to)
  if (from === "active") return ACTIVE_TO.includes(to)
  // terminal states are absorbing for most transitions; completed may be
  // re-marked failed (post-hoc classification). Resume may reactivate any
  // terminal record back to active (clears finishedAt in transition).
  if (from === "completed" && (to === "failed" || to === "completed")) return true
  if (TERMINAL.includes(from) && to === "active") return true
  return false
}

export interface RegisterInput {
  readonly parentSessionID: SessionSchema.ID
  readonly childSessionID: SessionSchema.ID
  readonly subagentType: string
  readonly address: string
}

export interface Interface {
  readonly register: (input: RegisterInput) => Effect.Effect<SubagentRecord>
  readonly transition: (
    childSessionID: SessionSchema.ID,
    to: SubagentStatus,
    patch?: Partial<Omit<SubagentRecord, "childSessionID" | "parentSessionID" | "subagentType" | "address">>,
  ) => Effect.Effect<void, InvalidTransition>
  readonly touchHeartbeat: (
    childSessionID: SessionSchema.ID,
    snapshot: { turnCount: number; toolCallCount: number; tokensUsed: number },
  ) => Effect.Effect<void>
  readonly get: (childSessionID: SessionSchema.ID) => Effect.Effect<SubagentRecord | undefined>
  readonly list: (filter?: { parentSessionID?: SessionSchema.ID; status?: SubagentStatus }) => Effect.Effect<SubagentRecord[]>
  readonly abortChildren: (parentSessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.ID[]>
  readonly snapshot: Effect.Effect<ReadonlyArray<SubagentRecord>>
  readonly activeCount: Effect.Effect<number>
  readonly activeCountByType: (subagentType: string) => Effect.Effect<number>
  readonly cancel: (childSessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly startWatcher: Effect.Effect<void, never, import("effect").Scope.Scope | Event.Service>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentRegistry") {}

export const make: Effect.Effect<Interface, never, SubagentLifecycle.Service> = Effect.gen(function* () {
  const lifecycle = yield* SubagentLifecycle.Service
  const records = yield* SynchronizedRef.make<RecordMap>(new Map())

  const register: Interface["register"] = (input) =>
    SynchronizedRef.modify(records, (map): readonly [SubagentRecord, RecordMap] => {
      const now = Date.now()
      const record: SubagentRecord = {
        childSessionID: input.childSessionID,
        parentSessionID: input.parentSessionID,
        subagentType: input.subagentType,
        status: "pending",
        createdAt: now,
        lastHeartbeatAt: now,
        turnCount: 0,
        toolCallCount: 0,
        tokensUsed: 0,
        cancelToken: `${input.childSessionID}-${now}`,
        address: input.address,
      }
      const next = new Map(map)
      next.set(input.childSessionID, record)
      return [record, next]
    }).pipe(
      Effect.flatMap((record) =>
        lifecycle.dispatch({ _tag: "Spawn", childSessionID: record.childSessionID, parentSessionID: record.parentSessionID, subagentType: record.subagentType, address: record.address }).pipe(Effect.as(record)),
      ),
    )

  const transition: Interface["transition"] = (childSessionID, to, patch) =>
    Effect.gen(function* () {
      const outcome = yield* SynchronizedRef.modify(
        records,
        (map): readonly [InvalidTransition | { record: SubagentRecord; from: SubagentStatus } | undefined, RecordMap] => {
          const current = map.get(childSessionID)
          if (!current) return [undefined, map]
          if (!isAllowed(current.status, to)) {
            return [new InvalidTransition({ childSessionID, from: current.status, to }), map]
          }
          const next = new Map(map)
          const now = Date.now()
          const record: SubagentRecord = {
            ...current,
            ...(patch ?? {}),
            status: to,
            ...(to === "active" && current.startedAt === undefined ? { startedAt: now } : {}),
            // Resume/reactivate: clear terminal bookkeeping so heartbeat/concurrency work.
            ...(to === "active" && TERMINAL.includes(current.status)
              ? { finishedAt: undefined, error: undefined, lastHeartbeatAt: now }
              : {}),
            ...(TERMINAL.includes(to) ? { finishedAt: now } : {}),
          }
          next.set(childSessionID, record)
          return [{ record, from: current.status }, next]
        },
      )
      if (outcome === undefined) return
      if (outcome instanceof InvalidTransition) yield* Effect.fail(outcome)
      if ("record" in outcome) {
        const { record, from } = outcome
        if (from !== "active" && record.status === "active") {
          yield* lifecycle.dispatch({ _tag: "Start", childSessionID: record.childSessionID, turnCount: record.turnCount })
        }
        if (record.status === "completed") {
          yield* lifecycle.dispatch({ _tag: "Complete", childSessionID: record.childSessionID, exit: "completed", resumeFrom: record.resumeFrom })
        }
        if (record.status === "failed") {
          yield* lifecycle.dispatch({ _tag: "Fail", childSessionID: record.childSessionID, error: record.error ?? "unknown", resumeFrom: record.resumeFrom })
        }
        if (record.status === "lost") {
          yield* lifecycle.dispatch({ _tag: "HeartbeatLost", childSessionID: record.childSessionID })
        }
      }
    })

  const touchHeartbeat: Interface["touchHeartbeat"] = (childSessionID, snapshot) =>
    SynchronizedRef.modify(records, (map) => {
      const current = map.get(childSessionID)
      if (!current) return [undefined, map] as const
      // Progress-only: observer keep-alive must NOT refresh lastHeartbeatAt.
      // Stall detection uses this timestamp as lastProgressAt.
      const progressed =
        snapshot.turnCount > current.turnCount ||
        snapshot.toolCallCount > current.toolCallCount ||
        snapshot.tokensUsed > current.tokensUsed
      const next = new Map(map)
      const record: SubagentRecord = {
        ...current,
        turnCount: snapshot.turnCount,
        toolCallCount: snapshot.toolCallCount,
        tokensUsed: snapshot.tokensUsed,
        ...(progressed ? { lastHeartbeatAt: Date.now() } : {}),
      }
      next.set(childSessionID, record)
      return [record, next] as const
    }).pipe(
      Effect.flatMap((record) =>
        record === undefined
          ? Effect.void
          : lifecycle.dispatch({
              _tag: "Turn",
              childSessionID: record.childSessionID,
              turnCount: record.turnCount,
              toolCallCount: record.toolCallCount,
              tokensUsed: record.tokensUsed,
            }),
      ),
    )

  const get: Interface["get"] = (childSessionID) =>
    SynchronizedRef.get(records).pipe(Effect.map((map) => map.get(childSessionID)))

  const list: Interface["list"] = (filter) =>
    SynchronizedRef.get(records).pipe(
      Effect.map((map) =>
        Array.from(map.values()).filter(
          (r) =>
            (filter?.parentSessionID === undefined || r.parentSessionID === filter.parentSessionID) &&
            (filter?.status === undefined || r.status === filter.status),
        ),
      ),
    )

  const abortChildren: Interface["abortChildren"] = (parentSessionID) =>
    Effect.gen(function* () {
      const children = yield* list({ parentSessionID })
      const ids: SessionSchema.ID[] = []
      for (const child of children) {
        if (TERMINAL.includes(child.status)) continue
        yield* lifecycle.dispatch({
          _tag: "Abort",
          childSessionID: child.childSessionID,
          reason: "parent_interrupt",
        })
        ids.push(child.childSessionID)
      }
      return ids
    })

  const snapshot: Interface["snapshot"] = SynchronizedRef.get(records).pipe(
    Effect.map((map) => Array.from(map.values()).map((r) => ({ ...r }))),
  )

  const activeCount: Interface["activeCount"] = SynchronizedRef.get(records).pipe(
    Effect.map((map) => Array.from(map.values()).filter((r) => r.status === "active").length),
  )

  const activeCountByType: Interface["activeCountByType"] = (subagentType) =>
    SynchronizedRef.get(records).pipe(
      Effect.map(
        (map) => Array.from(map.values()).filter((r) => r.status === "active" && r.subagentType === subagentType).length,
      ),
    )

  const cancel: Interface["cancel"] = (childSessionID) =>
    Effect.gen(function* () {
      const outcome = yield* SynchronizedRef.modify(records, (map) => {
        const current = map.get(childSessionID)
        if (!current) return [undefined, map] as const
        if (TERMINAL.includes(current.status)) return [undefined, map] as const
        const next = new Map(map)
        const record: SubagentRecord = { ...current, status: "cancelled", finishedAt: Date.now() }
        next.set(childSessionID, record)
        return [record, next] as const
      })
      if (outcome) {
        yield* lifecycle.dispatch({ _tag: "Abort", childSessionID, reason: "cancel" })
      }
    })

  const startWatcher: Interface["startWatcher"] = Effect.gen(function* () {
    const events = yield* Event.Service
    // Authority: lastHeartbeatAt is progress-only. Drain membership (execution.active)
    // does NOT exempt stall — a hung drain with frozen progress must be marked lost.
    const check = Effect.gen(function* () {
      const activeRecords = yield* SynchronizedRef.get(records).pipe(
        Effect.map((map) => Array.from(map.values()).filter((r) => r.status === "active")),
      )
      const now = Date.now()
      for (const record of activeRecords) {
        if (
          !shouldMarkStalled({
            status: record.status,
            lastProgressAt: record.lastHeartbeatAt,
            now,
          })
        ) {
          continue
        }
        const outcome = yield* transition(record.childSessionID, "lost").pipe(Effect.exit)
        if (outcome._tag === "Failure") continue
        yield* events
          .publish(SubagentHeartbeatLost, {
            timestamp: yield* DateTime.now,
            sessionID: record.parentSessionID,
            childSessionID: String(record.childSessionID),
          })
          .pipe(Effect.ignore)
      }
    })
    yield* check.pipe(
      Effect.repeat(Schedule.spaced(WATCHER_INTERVAL)),
      Effect.forkScoped,
      Effect.asVoid,
    )
  })

  return { register, transition, touchHeartbeat, get, list, abortChildren, snapshot, activeCount, activeCountByType, cancel, startWatcher }
})

/** Default progress-stall window before an active subagent is marked lost. */
export const PROGRESS_STALL_TIMEOUT_MS = 180_000
const WATCHER_INTERVAL = Duration.seconds(30)

/** Pure stall rule: active + no progress for STALL_MS → lost (drain membership ignored). */
export function shouldMarkStalled(input: {
  readonly status: SubagentStatus
  readonly lastProgressAt: number
  readonly now: number
  readonly timeoutMs?: number
}): boolean {
  if (input.status !== "active") return false
  if (input.now - input.lastProgressAt <= (input.timeoutMs ?? PROGRESS_STALL_TIMEOUT_MS)) return false
  return true
}

/** @deprecated Use shouldMarkStalled — drain exemption removed. */
export function shouldMarkHeartbeatLost(input: {
  readonly status: SubagentStatus
  readonly lastHeartbeatAt: number
  readonly now: number
  readonly childSessionID: SessionSchema.ID
  readonly draining: ReadonlySet<SessionSchema.ID> | undefined
  readonly timeoutMs?: number
}): boolean {
  return shouldMarkStalled({
    status: input.status,
    lastProgressAt: input.lastHeartbeatAt,
    now: input.now,
    timeoutMs: input.timeoutMs,
  })
}

export const layerForTest: Layer.Layer<Service, never, SubagentLifecycle.Service> = Layer.effect(Service, make)

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.gen(function* () {
      const svc = yield* make
      yield* svc.startWatcher
      return svc
    }),
  ),
  deps: [Event.node, SubagentLifecycle.node],
})
