import { describe, expect } from "bun:test"
import { DateTime, Duration, Effect, Fiber, Layer } from "effect"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"

import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MemoryDrainWatcher, drainTick, makeDrainState } from "../../src/memory/drain-watcher"
import { readTextSafe, resolveRoots } from "../../src/memory/storage"
import { sessionLogPath } from "../../src/memory/session-logs"

import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const sessionID = SessionSchema.ID.make("ses_drain_target")
const active = { current: new Set<string>([String(sessionID)]), polls: 0 }

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => {
      active.polls++
      return new Set([...active.current].map((id) => SessionSchema.ID.make(id)))
    }),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.void,
  }),
)

const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const sessionFor = (dir: string) =>
  SessionV2.Info.make({
    id: sessionID,
    projectID: ProjectV2.ID.global,
    title: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: { directory: AbsolutePath.make(path.join(dir, "proj")) },
  })

const storeFor = (dir: string) =>
  Layer.succeed(
    SessionStore.Service,
    SessionStore.Service.of({
      get: () => Effect.succeed(sessionFor(dir)),
      context: () =>
        Effect.succeed([
        SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_m1"),
          type: "user",
          text: "a substantive prompt about the memory system design",
          time: { created: DateTime.makeUnsafe(0) },
        }),
        SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_m2"),
          type: "user",
          text: "another prompt asking about session capture behavior",
          time: { created: DateTime.makeUnsafe(0) },
        }),
        SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_m3"),
          type: "user",
          text: "third prompt with enough detail to be non-trivial",
          time: { created: DateTime.makeUnsafe(0) },
        }),
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_m4"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created: DateTime.makeUnsafe(0) },
        }),
      ]),
      sessionPermission: () => Effect.die("unused"),
      runnerContext: () => Effect.die("unused"),
      message: () => Effect.die("unused"),
      wait: () => Effect.die("unused"),
    }),
  )

const layer = (dir: string, storeOverride?: Layer.Layer<SessionStore.Service>) =>
  Layer.mergeAll(
    LayerNode.compile(FSUtil.node),
    Global.layerWith({ data: path.join(dir, "global") }),
    execution,
    storeOverride ?? storeFor(dir),
  )

const it = testEffect(Layer.empty)

describe("Memory drain watcher", () => {
  it.live("writes a workspace session log after a session leaves active and the debounce passes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          active.current = new Set([String(sessionID)])
          const fiber = yield* MemoryDrainWatcher.startDrainWatcher({
            pollInterval: Duration.millis(100),
            idleDebounce: Duration.millis(200),
          }).pipe(Effect.forkScoped)
          // Let the first polls observe the session as active.
          yield* Effect.sleep(Duration.millis(300))
          active.current = new Set()
          // Poll marks it pending; debounce passes; log is written.
          yield* Effect.sleep(Duration.millis(700))
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "global", "memory"), path.join(dir.path, "proj"))
          const text = yield* readTextSafe(fs, sessionLogPath(roots, String(sessionID), new Date()))
          const files = yield* fs
            .readDirectoryEntries(path.join(roots.workspaceDir!, "sessions"))
            .pipe(Effect.catch(() => Effect.succeed([])))
          expect(JSON.stringify({ polls: active.polls, text, files: files.map((f) => f.name) })).toContain("# Session")
          // The session must not be re-logged on subsequent polls (single block).
          const blockCount = (text ?? "").split("# Session").length - 1
          expect(blockCount).toBe(1)
          // Extra polling time must not add duplicate blocks.
          yield* Effect.sleep(Duration.millis(400))
          const text2 = yield* readTextSafe(fs, sessionLogPath(roots, String(sessionID), new Date()))
          expect((text2 ?? "").split("# Session").length - 1).toBe(1)
          yield* Fiber.interrupt(fiber)
        }).pipe(Effect.provide(layer(dir.path))),
      ),
    ),
  )

  it.live("skips trivial sessions (few prompts)", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          active.current = new Set([String(sessionID)])
          const fiber = yield* MemoryDrainWatcher.startDrainWatcher({
            pollInterval: Duration.millis(100),
            idleDebounce: Duration.millis(200),
          }).pipe(Effect.forkScoped)
          yield* Effect.sleep(Duration.millis(300))
          active.current = new Set()
          yield* Effect.sleep(Duration.millis(700))
          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "global", "memory"), path.join(dir.path, "proj"))
          const text = yield* readTextSafe(fs, sessionLogPath(roots, String(sessionID), new Date()))
          expect(text).toBeUndefined()
          yield* Fiber.interrupt(fiber)
        }).pipe(
          Effect.provide(
            layer(
              dir.path,
              Layer.succeed(
                SessionStore.Service,
                SessionStore.Service.of({
                  get: () => Effect.succeed(sessionFor(dir.path)),
                  context: () =>
                    Effect.succeed([
                      SessionMessage.User.make({
                        id: SessionMessage.ID.make("msg_t1"),
                        type: "user",
                        text: "hi",
                        time: { created: DateTime.makeUnsafe(0) },
                      }),
                    ]),
                  sessionPermission: () => Effect.die("unused"),
                  runnerContext: () => Effect.die("unused"),
                  message: () => Effect.die("unused"),
                  wait: () => Effect.die("unused"),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  )

  it.live("scope finalizer flushes pending whose idle debounce already elapsed", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          active.current = new Set([String(sessionID)])
          active.polls = 0
          // Nested scope: long poll so the scheduled fiber does not flush after
          // pending is marked; the scope finalizer must perform that last drainTick.
          yield* Effect.gen(function* () {
            yield* MemoryDrainWatcher.startDrainWatcher({
              pollInterval: Duration.millis(400),
              idleDebounce: Duration.millis(40),
            })
            // First immediate tick sees active.
            yield* Effect.sleep(Duration.millis(80))
            active.current = new Set()
            // Next spaced tick (~400ms from start) marks pending; close the
            // nested scope before the following poll would flush (~800ms).
            yield* Effect.sleep(Duration.millis(400))
          }).pipe(Effect.scoped)

          const fs = yield* FSUtil.Service
          const roots = resolveRoots(path.join(dir.path, "global", "memory"), path.join(dir.path, "proj"))
          const logPath = sessionLogPath(roots, String(sessionID), new Date())
          const text = yield* readTextSafe(fs, logPath)
          expect(text).toContain("# Session")
          expect(text).toContain(String(sessionID))
          // Must land under workspace when session.location.directory is set.
          expect(logPath.includes(path.join(dir.path, "proj", ".opencode", "memory"))).toBe(true)
        }).pipe(Effect.provide(layer(dir.path))),
      ),
    ),
  )

  it.live("drainTick uses workspace roots from session location.directory", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const store = yield* SessionStore.Service
          const state = makeDrainState()
          const id = String(sessionID)
          state.seen.add(id)
          state.pending.set(id, 0)
          const rootsOf = (sid: string) =>
            Effect.gen(function* () {
              const session = yield* store.get(SessionSchema.ID.make(sid))
              return resolveRoots(path.join(dir.path, "global", "memory"), session.location?.directory)
            })
          yield* drainTick(state, 10_000, new Set(), store, rootsOf, fs, Duration.millis(1))
          const roots = resolveRoots(path.join(dir.path, "global", "memory"), path.join(dir.path, "proj"))
          const text = yield* readTextSafe(fs, sessionLogPath(roots, id, new Date()))
          expect(text).toContain("# Session")
          expect(roots.workspaceDir).toContain(path.join(".opencode", "memory"))
          expect(state.seen.has(id)).toBe(false)
        }).pipe(Effect.provide(layer(dir.path))),
      ),
    ),
  )
})
