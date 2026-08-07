export * as PersonaStore from "./store"

import { Context, Effect, Layer, SynchronizedRef } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import type { EffectiveSubagentConfig } from "./schema"
import { SessionSchema } from "../schema"

/**
 * Process-local map of childSessionID → EffectiveSubagentConfig.
 * Used for SystemPart rebuild and resume identity. Not durable across process restart;
 * resume without map falls back to no-persona (sessions remain resumable).
 */
export interface Interface {
  readonly put: (sessionID: SessionSchema.ID, config: EffectiveSubagentConfig) => Effect.Effect<void>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<EffectiveSubagentConfig | undefined>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export const Service = Context.Service<Interface>("@opencode/Persona/Store")

export const make: Effect.Effect<Interface> = Effect.gen(function* () {
  const ref = yield* SynchronizedRef.make(new Map<string, EffectiveSubagentConfig>())
  return {
    put: (sessionID, config) =>
      SynchronizedRef.update(ref, (m) => new Map(m).set(String(sessionID), config)),
    get: (sessionID) => SynchronizedRef.get(ref).pipe(Effect.map((m) => m.get(String(sessionID)))),
    remove: (sessionID) =>
      SynchronizedRef.update(ref, (m) => {
        const next = new Map(m)
        next.delete(String(sessionID))
        return next
      }),
  } satisfies Interface
})

export const layerForTest: Layer.Layer<Interface> = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer: Layer.effect(Service, make), deps: [] })
