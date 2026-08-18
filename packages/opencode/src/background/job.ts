import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { Database } from "@opencode-ai/core/database/database"
import { Event } from "@opencode-ai/core/event"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer, Option } from "effect"

export {
  Service,
  type ExtendInput,
  type Info,
  type Interface,
  type StartInput,
  type Status,
  type WaitInput,
  type WaitResult,
} from "@opencode-ai/core/background-job"

/** Keeps the legacy service instance-scoped while sharing the core registry engine. */
const layer = Layer.effect(
  CoreBackgroundJob.Service,
  Effect.gen(function* () {
    // Capture Database at layer build so per-instance `make()` still has SQL
    // even if the instance cache lookup fiber would otherwise miss the service.
    const database = yield* Effect.serviceOption(Database.Service)
    const events = yield* Effect.serviceOption(Event.Service)
    const state = yield* InstanceState.make(() => {
      let make = CoreBackgroundJob.make
      if (Option.isSome(database)) make = make.pipe(Effect.provideService(Database.Service, database.value))
      if (Option.isSome(events)) make = make.pipe(Effect.provideService(Event.Service, events.value))
      return make
    })
    return CoreBackgroundJob.Service.of({
      list: () => InstanceState.useEffect(state, (jobs) => jobs.list()),
      get: (id) => InstanceState.useEffect(state, (jobs) => jobs.get(id)),
      start: (input) => InstanceState.useEffect(state, (jobs) => jobs.start(input)),
      patch: (id, metadata) => InstanceState.useEffect(state, (jobs) => jobs.patch(id, metadata)),
      extend: (input) => InstanceState.useEffect(state, (jobs) => jobs.extend(input)),
      wait: (input) => InstanceState.useEffect(state, (jobs) => jobs.wait(input)),
      waitForPromotion: (id) => InstanceState.useEffect(state, (jobs) => jobs.waitForPromotion(id)),
      promote: (id) => InstanceState.useEffect(state, (jobs) => jobs.promote(id)),
      cancel: (id) => InstanceState.useEffect(state, (jobs) => jobs.cancel(id)),
    })
  }),
)

export const node = LayerNode.make({
  service: CoreBackgroundJob.Service,
  layer,
  deps: [Database.node, Event.node],
})

export * as BackgroundJob from "./job"
