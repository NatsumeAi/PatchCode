import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { SubagentRegistry } from "../../src/session/subagent-registry"
import { SubagentLifecycle } from "../../src/session/subagent-lifecycle"
import { SessionSchema } from "../../src/session/schema"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const parent = SessionSchema.ID.make("ses_parent_test")
const child = SessionSchema.ID.make("ses_child_test")

const registerChild = (status: "pending" | "active" = "pending") =>
  Effect.gen(function* () {
    const registry = yield* SubagentRegistry.Service
    yield* registry.register({ parentSessionID: parent, childSessionID: child, subagentType: "explore", address: "/root/t1" })
    if (status === "active") yield* registry.transition(child, "active")
  })

describe("SubagentRegistry", () => {
  it("register creates a pending record", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registerChild()
      const record = yield* registry.get(child)
      expect(record?.status).toBe("pending")
      expect(record?.parentSessionID).toBe(parent)
      expect(record?.subagentType).toBe("explore")
      expect(record?.address).toBe("/root/t1")
      expect(record?.cancelToken).toBeTruthy()
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(SubagentLifecycle.layerForTest))))
    await Effect.runPromise(program)
  })

  it("transition follows pending → active → completed", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registerChild("active")
      yield* registry.transition(child, "completed", { finishedAt: Date.now() })
      const record = yield* registry.get(child)
      expect(record?.status).toBe("completed")
      expect(record?.finishedAt).toBeTruthy()
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(SubagentLifecycle.layerForTest))))
    await Effect.runPromise(program)
  })

  it("invalid transition throws InvalidTransition", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registerChild()
      yield* registry.transition(child, "completed")
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(SubagentLifecycle.layerForTest))))
    const exit = await Effect.runPromiseExit(program)
    expect(Exit.isFailure(exit)).toBe(true)
    if (exit._tag === "Failure") {
      const errText = Cause.prettyErrors(exit.cause).join("\n")
      expect(errText).toContain("InvalidTransition")
    }
  })

  it("resume may reactivate a completed child (completed → active)", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registerChild("active")
      yield* registry.transition(child, "completed", { finishedAt: Date.now() })
      expect((yield* registry.get(child))?.status).toBe("completed")
      yield* registry.transition(child, "active")
      const record = yield* registry.get(child)
      expect(record?.status).toBe("active")
      expect(record?.finishedAt).toBeUndefined()
      expect(yield* registry.activeCount).toBe(1)
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(SubagentLifecycle.layerForTest))))
    await Effect.runPromise(program)
  })

  it("resume may reactivate a failed child (failed → active)", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registerChild("active")
      yield* registry.transition(child, "failed", { error: "boom" })
      yield* registry.transition(child, "active")
      const record = yield* registry.get(child)
      expect(record?.status).toBe("active")
      expect(record?.error).toBeUndefined()
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(SubagentLifecycle.layerForTest))))
    await Effect.runPromise(program)
  })

  it("transition lost is allowed from active (heartbeat loss)", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registerChild("active")
      yield* registry.transition(child, "lost")
      expect((yield* registry.get(child))?.status).toBe("lost")
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(SubagentLifecycle.layerForTest))))
    await Effect.runPromise(program)
  })

  it("cancel marks cancelled and records finishedAt", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registerChild("active")
      yield* registry.cancel(child)
      const record = yield* registry.get(child)
      expect(record?.status).toBe("cancelled")
      expect(record?.finishedAt).toBeTruthy()
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(SubagentLifecycle.layerForTest))))
    await Effect.runPromise(program)
  })

  it("touchHeartbeat updates counters and lastHeartbeatAt", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registerChild("active")
      yield* registry.touchHeartbeat(child, { turnCount: 3, toolCallCount: 7, tokensUsed: 1000 })
      const record = yield* registry.get(child)
      expect(record?.turnCount).toBe(3)
      expect(record?.toolCallCount).toBe(7)
      expect(record?.tokensUsed).toBe(1000)
      expect(record?.lastHeartbeatAt).toBeGreaterThan(0)
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(SubagentLifecycle.layerForTest))))
    await Effect.runPromise(program)
  })

  it("activeCount counts only active records", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registerChild("active")
      yield* registry.register({ parentSessionID: parent, childSessionID: SessionSchema.ID.make("ses_child2"), subagentType: "general", address: "/root/t2" })
      yield* registry.register({ parentSessionID: parent, childSessionID: SessionSchema.ID.make("ses_child3"), subagentType: "explore", address: "/root/t3" })
      yield* registry.transition(SessionSchema.ID.make("ses_child3"), "active")
      expect(yield* registry.activeCount).toBe(2)
      expect(yield* registry.activeCountByType("explore")).toBe(2)
      expect(yield* registry.activeCountByType("general")).toBe(0)
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(SubagentLifecycle.layerForTest))))
    await Effect.runPromise(program)
  })

  it("snapshot is a deep copy (mutating result does not affect registry)", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registerChild("active")
      const snap = yield* registry.snapshot
      const record = snap.find((r) => r.childSessionID === child)
      expect(record).toBeDefined()
      if (record) (record as { status: string }).status = "completed" // mutate snapshot
      expect((yield* registry.get(child))?.status).toBe("active")
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(SubagentLifecycle.layerForTest))))
    await Effect.runPromise(program)
  })

  it("list filters by parentSessionID", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registerChild()
      yield* registry.register({ parentSessionID: SessionSchema.ID.make("ses_other"), childSessionID: SessionSchema.ID.make("ses_child_other"), subagentType: "explore", address: "/root/x" })
      const list = yield* registry.list({ parentSessionID: parent })
      expect(list).toHaveLength(1)
      expect(list[0]?.childSessionID).toBe(child)
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(SubagentLifecycle.layerForTest))))
    await Effect.runPromise(program)
  })
  it("touchHeartbeat only refreshes lastHeartbeatAt when counters progress", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registerChild("active")
      const before = (yield* registry.get(child))!.lastHeartbeatAt
      yield* Effect.sync(() => Bun.sleepSync(5))
      yield* registry.touchHeartbeat(child, { turnCount: 0, toolCallCount: 0, tokensUsed: 0 })
      expect((yield* registry.get(child))!.lastHeartbeatAt).toBe(before)
      yield* registry.touchHeartbeat(child, { turnCount: 1, toolCallCount: 0, tokensUsed: 0 })
      expect((yield* registry.get(child))!.lastHeartbeatAt).toBeGreaterThan(before)
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(SubagentLifecycle.layerForTest))))
    await Effect.runPromise(program)
  })

  it("shouldMarkStalled: progress freeze → lost even while drain would be active", () => {
    const now = 400_000
    expect(
      SubagentRegistry.shouldMarkStalled({
        status: "active",
        lastProgressAt: 0,
        now,
      }),
    ).toBe(true)
    expect(
      SubagentRegistry.shouldMarkStalled({
        status: "active",
        lastProgressAt: now - 1_000,
        now,
      }),
    ).toBe(false)
    // Drain membership no longer protects — stale progress still stalls.
    expect(
      SubagentRegistry.shouldMarkHeartbeatLost({
        status: "active",
        lastHeartbeatAt: 0,
        now,
        childSessionID: child,
        draining: new Set([child]),
      }),
    ).toBe(true)
  })

  it("abortChildren dispatches parent_interrupt for live children only", async () => {
    const aborts: string[] = []
    const lifecycle = Layer.succeed(
      SubagentLifecycle.Service,
      SubagentLifecycle.Service.of({
        register: () => Effect.void,
        unregister: () => Effect.void,
        dispatch: (event) =>
          Effect.sync(() => {
            if (event._tag === "Abort") aborts.push(`${event.childSessionID}:${event.reason}`)
          }),
      }),
    )
    const done = SessionSchema.ID.make("ses_child_done")
    const live = SessionSchema.ID.make("ses_child_live")
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registry.register({
        parentSessionID: parent,
        childSessionID: live,
        subagentType: "explore",
        address: "/root/live",
      })
      yield* registry.transition(live, "active")
      yield* registry.register({
        parentSessionID: parent,
        childSessionID: done,
        subagentType: "explore",
        address: "/root/done",
      })
      yield* registry.transition(done, "active")
      yield* registry.transition(done, "completed")
      const ids = yield* registry.abortChildren(parent)
      expect(ids).toEqual([live])
      expect(aborts).toEqual([`${live}:parent_interrupt`])
    }).pipe(Effect.provide(SubagentRegistry.layerForTest.pipe(Layer.provideMerge(lifecycle))))
    await Effect.runPromise(program)
  })
})

describe("SubagentRegistry node", () => {
  it("compiles and serves through the global node with watcher started", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* SubagentRegistry.Service
      yield* registry.register({
        parentSessionID: parent,
        childSessionID: child,
        subagentType: "explore",
        address: "/root/t",
      })
      const record = yield* registry.get(child)
      expect(record?.status).toBe("pending")
    }).pipe(
      Effect.provide(
        LayerNode.compile(LayerNode.group([SubagentRegistry.node, SubagentLifecycle.node])),
      ),
    )
    await Effect.runPromise(program)
  })
})
