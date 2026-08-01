import { Effect, Layer, Schema, SynchronizedRef } from "effect"

export const SpawnEdgeStatus = Schema.Literals(["Open", "Closed"])
export type SpawnEdgeStatus = typeof SpawnEdgeStatus.Type

export const SessionSpawnEdgeSchema = Schema.Struct({
  parentSessionID: Schema.String,
  childSessionID: Schema.String,
  status: SpawnEdgeStatus,
  createdAt: Schema.Number,
  closedAt: Schema.optional(Schema.Number),
})
export type SessionSpawnEdge = typeof SessionSpawnEdgeSchema.Type

export class SpawnEdgeCannotReopen extends Schema.TaggedErrorClass<SpawnEdgeCannotReopen>()(
  "LoopControl.SpawnEdge.CannotReopen",
  { parent: Schema.String, child: Schema.String },
) {}

export interface SpawnEdge {
  schema: SessionSpawnEdge
  readonly ref: SynchronizedRef.SynchronizedRef<SpawnEdgeStatus>
}

export const make = (parentSessionID: string, childSessionID: string) =>
  Effect.gen(function* () {
    const ref = yield* SynchronizedRef.make<SpawnEdgeStatus>("Open")
    const schema: SessionSpawnEdge = {
      parentSessionID,
      childSessionID,
      status: "Open",
      createdAt: Date.now(),
    }
    return { schema, ref } satisfies SpawnEdge
  })

export const status = (edge: SpawnEdge) =>
  Effect.gen(function* () {
    const current = yield* SynchronizedRef.get(edge.ref)
    return { _tag: current } as const
  })

export const close = (edge: SpawnEdge) =>
  Effect.gen(function* () {
    yield* SynchronizedRef.update(edge.ref, () => "Closed" as const)
    edge.schema = {
      ...edge.schema,
      status: "Closed",
      closedAt: Date.now(),
    }
  })

export const open = (edge: SpawnEdge) =>
  Effect.fail(
    new SpawnEdgeCannotReopen({ parent: edge.schema.parentSessionID, child: edge.schema.childSessionID }),
  )

// make/status/close/open are pure (state lives on the edge instance), so the
// test layer provides nothing.
export const layerForTest: Layer.Layer<never> = Layer.empty

export * as SpawnEdge from "./spawn-edge"
