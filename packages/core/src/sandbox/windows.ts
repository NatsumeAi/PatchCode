export * as SandboxWindows from "./windows"

import { Schema } from "effect"

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("Sandbox.Unavailable", {
  profile: Schema.String,
  backend: Schema.String,
  reason: Schema.optional(Schema.String),
}) {}

export class Unsupported extends Schema.TaggedErrorClass<Unsupported>()("Sandbox.Unsupported", {
  platform: Schema.String,
  profile: Schema.String,
}) {}

export class Denied extends Schema.TaggedErrorClass<Denied>()("Sandbox.Denied", {
  op: Schema.String,
  path: Schema.String,
  profile: Schema.String,
  reason: Schema.optional(Schema.String),
}) {}

export class ProfileMismatch extends Schema.TaggedErrorClass<ProfileMismatch>()("Sandbox.ProfileMismatch", {
  sessionID: Schema.String,
  stored: Schema.String,
  requested: Schema.String,
}) {}

export class GlobOverflow extends Schema.TaggedErrorClass<GlobOverflow>()("Sandbox.GlobOverflow", {
  profile: Schema.String,
  hits: Schema.Number,
}) {}

export function windowsRefuse(profile: string) {
  return new Unsupported({ platform: "win32", profile })
}
