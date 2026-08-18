import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { EventBridge } from "@/event-bridge"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventBridge.Service

    // Process-global map keyed by sessionID. Do NOT use InstanceState here:
    // SessionRunner publishes session.status from a location layer without
    // InstanceRef; InstanceState.get would Die("InstanceRef not provided") and
    // abort the entire session drain.
    const data = new Map<SessionID, Info>()

    const applyLocal = (sessionID: SessionID, status: Info) => {
      if (status.type === "idle") data.delete(sessionID)
      else data.set(sessionID, status)
    }

    // Core SessionRunner publishes session.status on drain busy/idle. Mirror into
    // this map so GET /session/status stays accurate for TUI bootstrap.
    const unsubscribe = yield* events.listen((event) => {
      if (event.type !== "session.status") return Effect.void
      const props = event.data as { sessionID: SessionID; status: Info }
      applyLocal(props.sessionID, props.status)
      return Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(data)
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
      }
      applyLocal(sessionID, status)
    })

    return Service.of({ get, list, set })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventBridge.node] })

export * as SessionStatus from "./status"
