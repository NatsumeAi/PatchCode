import { Cause, Effect, Layer, Option } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SubagentRegistry } from "../subagent-registry"
import { TaskTool } from "../../tool/task"
import { Hooks } from "../../hooks"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const appTaskHost = yield* TaskTool.HostService

    // Mutable holder so drain fibers can re-resolve SessionExecution.Service
    // (FiberSet.makeRuntime freezes construction context, which does not yet
    // include this service; tools like task need wake/resume from the host).
    const holder: { current?: SessionExecution.Interface } = {}

    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        let effect = Effect.gen(function* () {
          const gated = yield* Hooks.fireSessionStart(sessionID)
          if (gated._tag === "Deny") return
          return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force }))
        }).pipe(Effect.provide(locations.get(session.location)))
        if (holder.current) {
          effect = effect.pipe(Effect.provideService(SessionExecution.Service, holder.current))
        }
        // App-layer task host (tests + ToolHostBridges) must win over the
        // location-graph placeholder. provide() after locations.get so the
        // replacement is visible at tool execute time.
        effect = effect.pipe(Effect.provideService(TaskTool.HostService, appTaskHost))
        return yield* effect.pipe(
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })

    const fanoutParentInterrupt = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        const registryOpt = yield* Effect.serviceOption(SubagentRegistry.Service)
        if (Option.isNone(registryOpt)) return
        const children = yield* registryOpt.value.abortChildren(sessionID)
        for (const child of children) {
          yield* coordinator.interrupt(child)
        }
      })

    const service = SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: (sessionID) =>
        fanoutParentInterrupt(sessionID).pipe(Effect.andThen(coordinator.interrupt(sessionID))),
      resume: coordinator.run,
      wake: coordinator.wake,
    })
    holder.current = service
    return service
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, TaskTool.hostNode],
})

export * as SessionExecutionLocal from "./local"
