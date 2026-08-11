export * as MemoryDelegation from "./delegation-wire"

import { Context, Effect, Layer } from "effect"
import path from "path"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { writeDelegationObservation } from "./delegation-memory"
import { resolveRoots, type MemoryRoots } from "./storage"

/**
 * Env gate for the delegation observation hook. Unset or any value other
 * than "0" enables recording subagent task/result candidates; set
 * `OPENCODE_MEMORY_DELEGATION=0` to disable without touching memory wiring.
 */
const delegationEnabled = (): boolean => process.env.OPENCODE_MEMORY_DELEGATION !== "0"

export interface DelegationObservation {
  readonly parentSessionID: string
  readonly childSessionID: string
  readonly task: string
  readonly result: string
  readonly ok: boolean
}

/**
 * Best-effort delegation writer with services already resolved: records one
 * subagent completion (task + result) as a memory candidate and degrades to
 * void on every failure — disabled env, empty text, threat patterns, missing
 * roots, or write errors. Never throws and never blocks a hot completion path.
 */
export const recordDelegationIfWired = Effect.fn("Memory.recordDelegationIfWired")(function* (
  fs: FSUtil.Interface,
  roots: MemoryRoots,
  input: DelegationObservation,
) {
  if (!delegationEnabled()) return
  yield* writeDelegationObservation(fs, roots, input).pipe(Effect.catch(() => Effect.void))
})

export interface Interface {
  readonly record: (input: DelegationObservation) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryDelegation") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    return Service.of({
      record: (input) =>
        recordDelegationIfWired(fs, resolveRoots(path.join(global.data, "memory"), location.directory), input),
    })
  }),
)

export const node = makeLocationNode({
  name: "memory-delegation",
  layer,
  deps: [FSUtil.node, Global.node, Location.node],
})
