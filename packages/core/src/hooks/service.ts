export * as HooksService from "./service"

import { Context, Effect, Layer, Option } from "effect"
import { eq } from "drizzle-orm"
import fs from "node:fs"
import path from "node:path"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { Event } from "../event"
import { Global } from "../global"
import { Location } from "../location"
import { SessionEvent } from "../session/event"
import { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { Trust } from "../trust"
import { dispatch, type InProcessHandler } from "./dispatch"
import { discover, type DiscoverResult } from "./load"
import type { Decision, EventName, LoadedSpec } from "./schema"

export type ListedHook = {
  readonly id: string
  readonly origin: string
  readonly file: string
}

export type LastDeny = {
  readonly hookId: string
  readonly event: EventName
  readonly reason: string
}

export type ListResult = {
  readonly loaded: readonly ListedHook[]
  readonly untrusted: boolean
  readonly lastDeny?: LastDeny
}

export type DispatchArgs = {
  readonly event: EventName
  readonly sessionID: string
  readonly toolName?: string
  readonly toolInput?: unknown
}

export interface Interface {
  readonly load: () => Effect.Effect<readonly LoadedSpec[]>
  readonly dispatch: (input: DispatchArgs) => Effect.Effect<Decision>
  readonly register: (handler: InProcessHandler) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ListResult>
  readonly ensureSessionStart: (sessionID: string) => Effect.Effect<Decision>
  readonly trust: (absPath: string) => Effect.Effect<string>
  readonly reload: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Hooks") {}

const allow: Decision = { _tag: "Allow" }

const LOCATION_SESSION = SessionSchema.ID.make("ses_hooks_location")

export const disabled = Layer.succeed(
  Service,
  Service.of({
    load: () => Effect.succeed([]),
    dispatch: () => Effect.succeed(allow),
    register: () => Effect.void,
    list: () => Effect.succeed({ loaded: [], untrusted: false }),
    ensureSessionStart: () => Effect.succeed(allow),
    trust: (absPath) => Effect.promise(() => Trust.grant(absPath)),
    reload: () => Effect.void,
  }),
)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const configDir = () => process.env.OPENCODE_CONFIG_DIR?.trim() || undefined
    const location = yield* Location.Service
    const dbOpt = yield* Effect.serviceOption(Database.Service)
    const eventsOpt = yield* Effect.serviceOption(Event.Service)
    const loadDiscovered = () =>
      discover({
        location: location.directory,
        ...(configDir() ? { configDir: configDir(), home: configDir() } : {}),
      })
    let discovered: DiscoverResult = yield* Effect.promise(() => loadDiscovered())
    const handlers: InProcessHandler[] = []
    const lastDenyFile = path.join(Global.Path.data, "hooks-last-deny.json")
    const readLastDeny = (): LastDeny | undefined => {
      try {
        const raw = JSON.parse(fs.readFileSync(lastDenyFile, "utf8")) as LastDeny
        if (raw && typeof raw.hookId === "string" && typeof raw.event === "string") return raw
      } catch {
        return undefined
      }
      return undefined
    }
    const writeLastDeny = (value: LastDeny) => {
      try {
        fs.mkdirSync(path.dirname(lastDenyFile), { recursive: true })
        fs.writeFileSync(lastDenyFile, JSON.stringify(value))
      } catch {
        // best-effort
      }
    }
    let lastDeny: LastDeny | undefined = readLastDeny()
    const askedTrust = new Set<string>()

    const events = () => (Option.isSome(eventsOpt) ? eventsOpt.value : undefined)

    const publishHook = (input: {
      readonly sessionID: string
      readonly event: string
      readonly hookId: string
      readonly source: string
      readonly decision: string
      readonly elapsedMs: number
      readonly reason?: string
    }) => {
      const bus = events()
      if (!bus) return Effect.void
      return bus
        .publish(SessionEvent.Hook, {
          sessionID: SessionSchema.ID.make(input.sessionID),
          event: input.event,
          hookId: input.hookId,
          source: input.source,
          decision: input.decision,
          elapsedMs: input.elapsedMs,
          reason: input.reason,
        })
        .pipe(Effect.ignore)
    }

    const announce = () =>
      Effect.gen(function* () {
        const loaded = discovered.specs.map((spec) => spec.id)
        yield* publishHook({
          sessionID: LOCATION_SESSION,
          event: "loaded",
          hookId: loaded[0] ?? "",
          source: "hooks.list",
          decision: discovered.untrusted ? "untrusted" : "allow",
          elapsedMs: 0,
          reason: loaded.join(","),
        })
        for (const file of discovered.threats) {
          yield* publishHook({
            sessionID: LOCATION_SESSION,
            event: "hooks.threat",
            hookId: file,
            source: "hooks.threat",
            decision: "deny",
            elapsedMs: 0,
            reason: "threat",
          })
        }
        if (discovered.untrusted) {
          yield* publishHook({
            sessionID: LOCATION_SESSION,
            event: "untrusted",
            hookId: "",
            source: "hooks.untrusted",
            decision: "allow",
            elapsedMs: 0,
            reason: "project hooks skipped",
          })
        }
      })

    const record = (sessionID: string, event: EventName, decision: Decision, elapsedMs: number) => {
      if (decision._tag === "Deny") {
        lastDeny = { hookId: decision.hookId, event, reason: decision.reason }
        writeLastDeny(lastDeny)
      }
      return publishHook({
        sessionID,
        event,
        hookId: decision._tag === "Deny" ? decision.hookId : "",
        source: "hooks",
        decision: decision._tag === "Deny" ? "deny" : "allow",
        elapsedMs,
        reason: decision._tag === "Deny" ? decision.reason : undefined,
      })
    }

    const readStart = (sessionID: string) =>
      Effect.gen(function* () {
        if (Option.isNone(dbOpt)) return "pending" as const
        const row = yield* dbOpt.value.db
          .select({ hooks_session_start: SessionTable.hooks_session_start })
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionSchema.ID.make(sessionID)))
          .get()
          .pipe(Effect.orDie)
        const value = row?.hooks_session_start
        if (value === "allow" || value === "deny" || value === "pending") return value
        return "pending" as const
      })

    const writeStart = (sessionID: string, value: "allow" | "deny") =>
      Effect.gen(function* () {
        if (Option.isNone(dbOpt)) return
        yield* dbOpt.value.db
          .update(SessionTable)
          .set({ hooks_session_start: value })
          .where(eq(SessionTable.id, SessionSchema.ID.make(sessionID)))
          .run()
          .pipe(Effect.orDie, Effect.ignore)
      })

    const runDispatch = (input: DispatchArgs) => {
      const started = Date.now()
      return dispatch({
        event: input.event,
        sessionID: input.sessionID,
        cwd: location.directory,
        toolName: input.toolName,
        toolInput: input.toolInput,
        specs: discovered.specs,
        handlers,
        sessionIDForWrap: input.sessionID,
      }).pipe(
        Effect.tap((decision) => record(input.sessionID, input.event, decision, Math.max(0, Date.now() - started))),
      )
    }

    const reload = () =>
      Effect.gen(function* () {
        discovered = yield* Effect.promise(() => loadDiscovered())
        yield* announce()
      })

    yield* announce()

    return Service.of({
      load: () => Effect.succeed(discovered.specs),
      dispatch: runDispatch,
      register: (handler) =>
        Effect.sync(() => {
          handlers.push(handler)
        }),
      list: () =>
        Effect.succeed({
          loaded: discovered.specs.map((spec) => ({ id: spec.id, origin: spec.origin, file: spec.file })),
          untrusted: discovered.untrusted,
          lastDeny,
        }),
      ensureSessionStart: (sessionID) =>
        Effect.gen(function* () {
          const dir = location.directory
          if (Trust.isInteractive() && !askedTrust.has(dir)) {
            const trusted = yield* Effect.promise(() =>
              Trust.isTrusted(dir, configDir() ? { configDir: configDir() } : {}),
            )
            if (!trusted) {
              askedTrust.add(dir)
              const bus = events()
              if (bus) {
                // Detached so a slow event bus cannot block SessionStart / the live drain.
                yield* Effect.forkDetach(
                  bus.publish(SessionEvent.TrustAsked, {
                    sessionID: SessionSchema.ID.make(sessionID),
                    directory: dir,
                  }).pipe(Effect.ignore),
                )
              }
            }
          }
          const state = yield* readStart(sessionID)
          if (state === "allow") return allow
          if (state === "deny")
            return {
              _tag: "Deny",
              reason: "session blocked by SessionStart hook",
              hookId: "session-start",
            } satisfies Decision
          const decision = yield* runDispatch({ event: "SessionStart", sessionID })
          yield* writeStart(sessionID, decision._tag === "Deny" ? "deny" : "allow")
          return decision._tag === "Deny" ? decision : allow
        }),
      trust: (absPath) =>
        Effect.gen(function* () {
          const granted = yield* Effect.promise(() => Trust.grant(absPath, configDir() ? { configDir: configDir() } : {}))
          askedTrust.add(granted)
          yield* reload()
          return granted
        }),
      reload,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node, Event.node, Database.node],
})

export const fire = (input: DispatchArgs) =>
  Effect.serviceOption(Service).pipe(
    Effect.flatMap((opt) =>
      Option.isSome(opt) ? opt.value.dispatch(input) : Effect.succeed({ _tag: "Allow" as const }),
    ),
  )

export const fireSessionStart = (sessionID: string) =>
  Effect.serviceOption(Service).pipe(
    Effect.flatMap((opt) =>
      Option.isSome(opt) ? opt.value.ensureSessionStart(sessionID) : Effect.succeed({ _tag: "Allow" as const }),
    ),
  )

export const fireSessionEnd = (sessionID: string) => fire({ event: "SessionEnd", sessionID })
