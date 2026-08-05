export * as SubagentLifecycle from "./subagent-lifecycle"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"

export type SubagentLifecycleEvent =
  | { _tag: "Spawn"; childSessionID: SessionSchema.ID; parentSessionID: SessionSchema.ID; subagentType: string; address: string }
  | { _tag: "Start"; childSessionID: SessionSchema.ID; turnCount: number }
  | { _tag: "Turn"; childSessionID: SessionSchema.ID; turnCount: number; toolCallCount: number; tokensUsed: number }
  | { _tag: "Complete"; childSessionID: SessionSchema.ID; exit: string; resumeFrom?: string }
  | { _tag: "Fail"; childSessionID: SessionSchema.ID; error: string; resumeFrom?: string }
  | { _tag: "Abort"; childSessionID: SessionSchema.ID; reason: "parent_interrupt" | "hard_abort" | "cancel" }
  | { _tag: "HeartbeatLost"; childSessionID: SessionSchema.ID }
  | { _tag: "SessionIdle"; sessionID: SessionSchema.ID }

export type Contributor = {
  readonly name: string
  readonly version: number
  readonly on?: {
    readonly [K in SubagentLifecycleEvent["_tag"]]?: (
      event: Extract<SubagentLifecycleEvent, { _tag: K }>,
    ) => Effect.Effect<void>
  }
}

export interface Interface {
  readonly register: (contributor: Contributor) => Effect.Effect<void, VersionMismatch>
  readonly unregister: (name: string) => Effect.Effect<void>
  readonly dispatch: (event: SubagentLifecycleEvent) => Effect.Effect<void>
}

export class VersionMismatch extends Error {
  constructor(
    readonly contributor: string,
    readonly supported: number,
  ) {
    super(`Lifecycle contributor "${contributor}" declares version ${supported} which is not the current version`)
    this.name = "SubagentLifecycleVersionMismatch"
  }
}

const CURRENT_VERSION = 1

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SubagentLifecycle") {}

export const make: Effect.Effect<Interface> = Effect.gen(function* () {
  const contributors = yield* SynchronizedRef.make(new Map<string, Contributor>())

  const register: Interface["register"] = (contributor) =>
    Effect.gen(function* () {
      if (contributor.version !== CURRENT_VERSION) {
        yield* Effect.fail(new VersionMismatch(contributor.name, contributor.version))
      }
      yield* SynchronizedRef.update(contributors, (map) => new Map(map).set(contributor.name, contributor))
    })

  const unregister: Interface["unregister"] = (name) =>
    SynchronizedRef.update(contributors, (map) => {
      const next = new Map(map)
      next.delete(name)
      return next
    })

  const dispatch: Interface["dispatch"] = (event) =>
    Effect.gen(function* () {
      const list = Array.from((yield* SynchronizedRef.get(contributors)).values())
      for (const contributor of list) {
        const handler = contributor.on?.[event._tag] as
          | ((e: SubagentLifecycleEvent) => Effect.Effect<void>)
          | undefined
        if (!handler) continue
        yield* handler(event).pipe(
          Effect.exit,
          Effect.tap((exit) => {
            if (exit._tag === "Failure") {
              return Effect.logWarning("subagent lifecycle hook failed", {
                contributor: contributor.name,
                event: event._tag,
              })
            }
            return Effect.void
          }),
        )
      }
    })

  return { register, unregister, dispatch }
})

export const layerForTest: Layer.Layer<Service> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [] })
