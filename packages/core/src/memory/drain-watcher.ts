export * as MemoryDrainWatcher from "./drain-watcher"

import { Clock, Duration, Effect, Layer, Schedule } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { SessionExecution } from "../session/execution"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { resolveRoots, type MemoryRoots } from "./storage"
import { appendSessionLog, isTrivialSession } from "./session-logs"
import { extractSessionMeta } from "./session-meta"

const POLL_INTERVAL = Duration.seconds(30)
const IDLE_DEBOUNCE = Duration.seconds(60)

export interface DrainState {
  readonly seen: Set<string>
  readonly pending: Map<string, number>
}

export const makeDrainState = (): DrainState => ({ seen: new Set(), pending: new Map() })

/**
 * One poll cycle: tracks sessions that left `active` and, after the idle
 * debounce, appends a zero-LLM metadata log for non-trivial sessions.
 * Exposed for direct testing; the watcher fiber calls it on a schedule.
 */
export const drainTick = Effect.fn("Memory.drainTick")(function* (
  state: DrainState,
  now: number,
  active: ReadonlySet<string>,
  store: SessionStore.Interface,
  roots: MemoryRoots,
  fs: FSUtil.Interface,
  idleDebounce: Duration.Duration = IDLE_DEBOUNCE,
) {
  for (const id of [...state.seen]) {
    if (active.has(id)) state.pending.delete(id)
    else if (!state.pending.has(id)) state.pending.set(id, now)
  }
  for (const [id, leftAt] of [...state.pending]) {
    if (leftAt !== undefined && now - leftAt >= Duration.toMillis(idleDebounce)) {
      state.pending.delete(id)
      const meta = yield* extractSessionMeta(store, SessionSchema.ID.make(id)).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (meta === undefined) continue
      if (isTrivialSession({ userPromptCount: meta.userPrompts, userTextBytes: meta.userTextBytes })) continue
      const lines = [
        `# Session ${id}`,
        `- date: ${meta.date}`,
        `- user prompts: ${meta.userPrompts}`,
        `- assistant messages: ${meta.assistantMessages}`,
        `- tool results: ${meta.toolResults}`,
        ...(meta.topics.length > 0 ? [`- topics: ${meta.topics.join(" | ")}`] : []),
      ].join("\n")
      console.log("APPEND-CALL", JSON.stringify({ roots, id }))
      yield* appendSessionLog(fs, roots, id, new Date(), lines)
      console.log("APPEND-DONE")
    }
  }
  for (const id of active) state.seen.add(id)
})

/** Forks a scoped poller that saves session metadata after each drain end. */
export const startDrainWatcher = (options: { pollInterval?: Duration.Duration; idleDebounce?: Duration.Duration } = {}) =>
  Effect.gen(function* () {
  const execution = yield* SessionExecution.Service
  const store = yield* SessionStore.Service
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const location = yield* Location.Service
  const rootsOf = () => resolveRoots(path.join(global.data, "memory"), location.directory)
  const state = makeDrainState()

  const tick = Effect.gen(function* () {
    const [now, active] = yield* Effect.all([
      Clock.currentTimeMillis,
      execution.active.pipe(Effect.map((ids) => new Set([...ids].map((id) => String(id))))),
    ])
    yield* drainTick(state, now, active, store, rootsOf(), fs, options.idleDebounce ?? IDLE_DEBOUNCE)
  })

  yield* tick.pipe(
    Effect.repeat(Schedule.spaced(options.pollInterval ?? POLL_INTERVAL)),
    Effect.forkScoped,
  )
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* startDrainWatcher()
  }),
)

export const node = makeLocationNode({
  name: "memory-drain-watcher",
  layer,
  deps: [SessionExecution.node, SessionStore.node, Global.node, Location.node, FSUtil.node],
})
