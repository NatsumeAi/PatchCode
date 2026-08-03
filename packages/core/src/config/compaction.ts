export * as ConfigCompaction from "./compaction"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export class Keep extends Schema.Class<Keep>("ConfigV2.Compaction.Keep")({
  recent: Schema.Number.pipe(Schema.optional),
}) {}

export class Select extends Schema.Class<Select>("ConfigV2.Compaction.Select")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  budget: Schema.Number.pipe(Schema.optional),
  retry: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Summary extends Schema.Class<Summary>("ConfigV2.Compaction.Summary")({
  l: NonNegativeInt.pipe(Schema.optional),
  k: NonNegativeInt.pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Compaction")({
  auto: Schema.Boolean.pipe(Schema.optional),
  prune: Schema.Boolean.pipe(Schema.optional),
  keep: Keep.pipe(Schema.optional),
  buffer: NonNegativeInt.pipe(Schema.optional),
  select: Select.pipe(Schema.optional),
  summary: Summary.pipe(Schema.optional),
}) {}
