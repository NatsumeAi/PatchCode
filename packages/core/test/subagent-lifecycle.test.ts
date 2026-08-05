import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { SubagentLifecycle } from "../src/session/subagent-lifecycle"
import { SessionSchema } from "../src/session/schema"

const childID = SessionSchema.ID.make("ses_child")
const parentID = SessionSchema.ID.make("ses_parent")

const events: string[] = []

const recordingContributor = (on?: SubagentLifecycle.Contributor["on"]) =>
  ({
    name: "recorder",
    version: 1,
    on: on ?? {
      Spawn: (event) =>
        Effect.sync(() => {
          events.push(`spawn:${event.childSessionID}`)
        }),
      Start: (event) =>
        Effect.sync(() => {
          events.push(`start:${event.childSessionID}`)
        }),
    },
  } satisfies SubagentLifecycle.Contributor)

describe("SubagentLifecycle", () => {
  it("dispatches to registered contributors", async () => {
    events.length = 0
    const program = Effect.gen(function* () {
      const svc = yield* SubagentLifecycle.Service
      yield* svc.register(recordingContributor())
      yield* svc.dispatch({ _tag: "Spawn", childSessionID: childID, parentSessionID: parentID, subagentType: "explore", address: "/root/t" })
      yield* svc.dispatch({ _tag: "Start", childSessionID: childID, turnCount: 0 })
    }).pipe(Effect.provide(SubagentLifecycle.layerForTest))
    await Effect.runPromise(program)
    expect(events).toEqual(["spawn:ses_child", "start:ses_child"])
  })

  it("isolates hook errors from the dispatch loop", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* SubagentLifecycle.Service
      yield* svc.register({
        name: "exploder",
        version: 1,
        on: {
          Spawn: () =>
            Effect.sync(() => {
              throw new Error("hook boom")
            }),
        },
      })
      yield* svc.register(recordingContributor())
      yield* svc.dispatch({ _tag: "Spawn", childSessionID: childID, parentSessionID: parentID, subagentType: "explore", address: "/root/t" })
    }).pipe(Effect.provide(SubagentLifecycle.layerForTest))
    const exit = await Effect.runPromiseExit(program)
    expect(exit._tag).toBe("Success")
    expect(events).toContain("spawn:ses_child")
  })

  it("rejects contributors with wrong version", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* SubagentLifecycle.Service
      yield* svc.register({ name: "old", version: 0 })
    }).pipe(Effect.provide(SubagentLifecycle.layerForTest))
    const exit = await Effect.runPromiseExit(program)
    expect(exit._tag).toBe("Failure")
  })

  it("unregister stops dispatch", async () => {
    events.length = 0
    const program = Effect.gen(function* () {
      const svc = yield* SubagentLifecycle.Service
      const contributor = recordingContributor()
      yield* svc.register(contributor)
      yield* svc.unregister("recorder")
      yield* svc.dispatch({ _tag: "Spawn", childSessionID: childID, parentSessionID: parentID, subagentType: "explore", address: "/root/t" })
    }).pipe(Effect.provide(SubagentLifecycle.layerForTest))
    await Effect.runPromise(program)
    expect(events).toEqual([])
  })
})
