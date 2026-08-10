export * as MemoryDrainWatcher from "./drain-watcher"

import { Clock, Duration, Effect, Layer, Schedule } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"
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
 *
 * Skip reasons are logged (meta fail, trivial). Append failures re-queue as
 * already-due so the next poll retries without a full debounce wait.
 */
export const drainTick = Effect.fn("Memory.drainTick")(function* (
  state: DrainState,
  now: number,
  active: ReadonlySet<string>,
  store: SessionStore.Interface,
  rootsOf: (sessionID: string) => Effect.Effect<MemoryRoots>,
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
      if (meta === undefined) {
        yield* Effect.logInfo(`memory drain skip: meta fail for session ${id}`)
        // Re-queue as already-due so a transient store failure can recover.
        state.pending.set(id, now - Duration.toMillis(idleDebounce))
        continue
      }
      if (isTrivialSession({ userPromptCount: meta.userPrompts, userTextBytes: meta.userTextBytes })) {
        yield* Effect.logInfo(
          `memory drain skip: trivial session ${id} (prompts=${meta.userPrompts} bytes=${meta.userTextBytes})`,
        )
        // Permanent for this process: do not re-log trivial sessions every poll.
        state.seen.delete(id)
        continue
      }
      const lines = [
        `# Session ${id}`,
        `- date: ${meta.date}`,
        `- user prompts: ${meta.userPrompts}`,
        `- assistant messages: ${meta.assistantMessages}`,
        `- tool results: ${meta.toolResults}`,
        ...(meta.topics.length > 0 ? [`- topics: ${meta.topics.join(" | ")}`] : []),
      ].join("\n")
      const roots = yield* rootsOf(id)
      const written = yield* appendSessionLog(fs, roots, id, new Date(), lines)
      if (!written) {
        yield* Effect.logWarning(`memory drain append failed for session ${id}`)
        // Re-queue as already-due so the next poll retries without a full debounce.
        state.pending.set(id, now - Duration.toMillis(idleDebounce))
        continue
      }
      state.seen.delete(id)
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
    const idleDebounce = options.idleDebounce ?? IDLE_DEBOUNCE
    // Per-session roots: prefer the session's location.directory so workspace
    // sessions write under <project>/.opencode/memory, not only global.
    const rootsOf = (id: string): Effect.Effect<MemoryRoots> =>
      Effect.gen(function* () {
        const session = yield* Effect.orElseSucceed(store.get(SessionSchema.ID.make(id)), () => undefined)
        return resolveRoots(path.join(global.data, "memory"), session?.location?.directory)
      })
    const state = makeDrainState()

    const tick = Effect.gen(function* () {
      const [now, active] = yield* Effect.all([
        Clock.currentTimeMillis,
        execution.active.pipe(Effect.map((ids) => new Set([...ids].map((id) => String(id))))),
      ])
      yield* drainTick(state, now, active, store, rootsOf, fs, idleDebounce)
    })

    // Best-effort final drain on scope close. Force every pending (and still-seen)
    // session past the idle debounce so one-shot CLI / fast process exit does not
    // permanently drop the last session metadata log.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const forceAt = now - Duration.toMillis(idleDebounce) - 1
        for (const id of state.seen) {
          if (!state.pending.has(id)) state.pending.set(id, forceAt)
        }
        for (const id of [...state.pending.keys()]) {
          state.pending.set(id, forceAt)
        }
        yield* tick
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`memory drain finalizer tick failed: ${String(error)}`).pipe(Effect.asVoid),
        ),
      ),
    )

    yield* tick.pipe(
      Effect.catch(() => Effect.void),
      Effect.repeat(Schedule.spaced(options.pollInterval ?? POLL_INTERVAL)),
      Effect.forkScoped,
    )
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* startDrainWatcher()
  }),
)

export const node = makeGlobalNode({
  name: "memory-drain-watcher",
  layer,
  deps: [SessionExecution.node, SessionStore.node, Global.node, FSUtil.node],
})
