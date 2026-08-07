export * as PersonaSchema from "./schema"

import { Schema } from "effect"

export class PersonaInfo extends Schema.Class<PersonaInfo>("Persona.Info")({
  name: Schema.String,
  instructions: Schema.String.pipe(Schema.optional),
  instructions_file: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  inputs: Schema.Array(Schema.String).pipe(Schema.optional),
  outputs: Schema.Array(Schema.String).pipe(Schema.optional),
  capability: Schema.Literals(["read-only", "read-write", "execute", "all"]).pipe(Schema.optional),
}) {}

export class EffectiveSubagentConfig extends Schema.Class<EffectiveSubagentConfig>("Persona.Effective")({
  personaName: Schema.String.pipe(Schema.optional),
  instructions: Schema.String,
  source: Schema.Literals(["task_override", "agent_default", "parent", "none"]),
  path: Schema.String.pipe(Schema.optional),
  fingerprint: Schema.String,
  inputs: Schema.Array(Schema.String).pipe(Schema.optional),
  outputs: Schema.Array(Schema.String).pipe(Schema.optional),
  capabilityTighten: Schema.Literals(["read-only", "read-write", "execute", "all"]).pipe(Schema.optional),
}) {}
