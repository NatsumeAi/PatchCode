export * as DoomLoop from "./doom-loop"

import { Schema } from "effect"

export const DoomLoopSignalKind = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("TailRepetition"), count: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("LowLogprob") }),
  Schema.Struct({ kind: Schema.Literal("Unknown"), reason: Schema.String }),
])
export type DoomLoopSignalKind = Schema.Schema.Type<typeof DoomLoopSignalKind>

export const DoomLoopSignal = Schema.Struct({
  channel: Schema.String,
  signal: DoomLoopSignalKind,
})
export type DoomLoopSignal = Schema.Schema.Type<typeof DoomLoopSignal>
