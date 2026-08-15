export * as DynamicTools from "./dynamic"

import { Context, Effect, Layer, Option, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"
import { SystemContextRegistry } from "../system-context/registry"

/**
 * Host-provided installer for dynamic tools (MCP, plugins) into the Location
 * Tools.Service registry. Built-ins register themselves; dynamic tools are
 * installed once per Location boot and may re-register when the host catalog
 * changes (Scope finalizers drop prior registrations).
 */
export interface Host {
  /**
   * Register dynamic tools via `Tools.Service`. Must complete under the
   * Location scope so unregistration happens when the Location tears down.
   * Host may fork long-lived refresh fibers with `Effect.forkScoped`.
   * Location, PermissionV2, and SystemContextRegistry are available in ambient
   * context when install runs.
   */
  readonly install: Effect.Effect<
    void,
    never,
    Tools.Service | Scope.Scope | Location.Service | PermissionV2.Service | SystemContextRegistry.Service
  >
}

export class HostService extends Context.Service<HostService, Host>()("@opencode/v2/DynamicTools.Host") {}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const host = yield* Effect.serviceOption(HostService)
    if (Option.isNone(host)) return
    // Tools/Location/Permission come from this Location layer graph.
    yield* host.value.install.pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "dynamic-tools",
  layer,
  deps: [ToolRegistry.toolsNode, Location.node, PermissionV2.node, SystemContextRegistry.node],
})
