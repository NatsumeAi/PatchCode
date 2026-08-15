export * as SandboxService from "./service"

import { Context, Effect, Layer, Option } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Global } from "../global"
import { Location } from "../location"
import { SessionEvent } from "../session/event"
import { SessionSchema } from "../session/schema"
import { assertPath as assertPathPure, type PathOp } from "./assert-path"
import { type SpawnClass } from "./linux-bwrap"
import { pinSession, pinnedProfile, resolvePinned } from "./resolve"
import { wrapSpawn as wrapSpawnPure, type WrapSpawnInput, type WrapSpawnResult } from "./wrap-spawn"
import { Denied, GlobOverflow, ProfileMismatch, Unavailable, Unsupported } from "./windows"

export { Denied, GlobOverflow, ProfileMismatch, Unavailable, Unsupported }
export type { SpawnClass, WrapSpawnInput, WrapSpawnResult }

export interface ResolveOutput {
  readonly name: string
  readonly location: string
  readonly writeRoots: readonly string[]
  readonly readRoots: readonly string[]
  readonly denyGlobs: readonly string[]
  readonly restrictNetwork: boolean
}

export interface WrapInput {
  readonly class: SpawnClass
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly sessionID?: string
  readonly profileName?: string
  readonly whenUnpinned?: "off" | "location"
  readonly bwrapPath?: string
  readonly platform?: string
}

export interface Interface {
  readonly resolve: (sessionID: string) => Effect.Effect<ResolveOutput, Unavailable>
  readonly assertPath: (op: PathOp, target: string, sessionID?: string) => Effect.Effect<void, Denied | Unavailable>
  readonly wrapSpawn: (input: WrapInput) => Effect.Effect<WrapSpawnResult, Unavailable | Unsupported | GlobOverflow>
  readonly pin: (sessionID: string, profile: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Sandbox") {}

const publish = (
  events: EventV2.Interface | undefined,
  data: { profile: string; class?: string; reason: string; backend?: string; sessionID?: string },
) => {
  if (!events || !data.sessionID) return Effect.void
  return events
    .publish(SessionEvent.Sandbox, {
      sessionID: SessionSchema.ID.make(data.sessionID),
      profile: data.profile,
      class: data.class,
      reason: data.reason,
      backend: data.backend,
    })
    .pipe(Effect.ignore)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const maybeEvents = yield* Effect.serviceOption(EventV2.Service)
    const eventService = Option.isSome(maybeEvents) ? maybeEvents.value : undefined

    const resolve = Effect.fn("Sandbox.resolve")(function* (sessionID: string) {
      const resolved = yield* Effect.tryPromise({
        try: () =>
          resolvePinned({
            sessionID,
            location: location.directory,
            whenUnpinned: "off",
          }),
        catch: (cause) =>
          cause instanceof Unavailable
            ? cause
            : new Unavailable({
                profile: pinnedProfile(sessionID) ?? "off",
                backend: process.platform,
                reason: cause instanceof Error ? cause.message : String(cause),
              }),
      })
      return {
        name: resolved.profile.name,
        location: resolved.location,
        writeRoots: resolved.profile.writeRoots,
        readRoots: resolved.profile.readRoots,
        denyGlobs: resolved.profile.denyGlobs,
        restrictNetwork: resolved.profile.restrictNetwork,
      } satisfies ResolveOutput
    })

    const assertPath = Effect.fn("Sandbox.assertPath")(function* (op: PathOp, target: string, sessionID?: string) {
      const resolved = yield* Effect.tryPromise({
        try: () =>
          resolvePinned({
            sessionID,
            location: location.directory,
            whenUnpinned: "off",
          }),
        catch: (cause) =>
          cause instanceof Unavailable
            ? cause
            : new Unavailable({ profile: "off", backend: process.platform, reason: String(cause) }),
      })
      const decision = assertPathPure(resolved.profile, op, target)
      if (decision._tag === "Deny") {
        yield* publish(eventService, {
          sessionID,
          profile: resolved.profile.name,
          reason: "denied",
          backend: process.platform,
        })
        return yield* new Denied({
          op,
          path: target,
          profile: resolved.profile.name,
          reason: decision.reason,
        })
      }
    })

    const wrapSpawn = Effect.fn("Sandbox.wrapSpawn")(function* (input: WrapInput) {
      return yield* Effect.tryPromise({
        try: () =>
          wrapSpawnPure({
            class: input.class,
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            sessionID: input.sessionID,
            profileName: input.profileName,
            whenUnpinned: input.whenUnpinned,
            location: location.directory,
            bwrapPath: input.bwrapPath,
            platform: input.platform,
          }),
        catch: (cause) => {
          if (cause instanceof Unavailable || cause instanceof Unsupported || cause instanceof GlobOverflow) {
            return cause
          }
          return new Unavailable({
            profile: input.profileName ?? pinnedProfile(input.sessionID) ?? "off",
            backend: input.platform ?? process.platform,
            reason: cause instanceof Error ? cause.message : String(cause),
          })
        },
      }).pipe(
        Effect.tapError((error) =>
          publish(eventService, {
            sessionID: input.sessionID,
            profile: input.profileName ?? pinnedProfile(input.sessionID) ?? "off",
            class: input.class,
            reason:
              error instanceof Unsupported
                ? "unsupported"
                : error instanceof GlobOverflow
                  ? "glob_overflow"
                  : "unavailable",
            backend: input.platform ?? process.platform,
          }),
        ),
      )
    })

    return Service.of({
      resolve,
      assertPath,
      wrapSpawn,
      pin: (sessionID, profile) => Effect.sync(() => pinSession(sessionID, profile)),
    })
  }),
)

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    resolve: () =>
      Effect.succeed({
        name: "off",
        location: "",
        writeRoots: [],
        readRoots: [],
        denyGlobs: [],
        restrictNetwork: false,
      }),
    assertPath: () => Effect.void,
    wrapSpawn: (input) => Effect.succeed({ command: input.command, args: [...input.args] }),
    pin: () => Effect.void,
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [Location.node, Global.node],
})
