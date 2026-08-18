export * as WebSearchConfig from "./websearch-config"

import { Context, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { truthy } from "../flag/flag"

export const Provider = ["exa", "parallel"] as const
export type Provider = (typeof Provider)[number]

export interface Config {
  readonly provider?: Provider
  readonly enableExa: boolean
  readonly enableParallel: boolean
  readonly exaApiKey?: string
  readonly parallelApiKey?: string
}

export class ConfigService extends Context.Service<ConfigService, Config>()("@opencode/WebSearchConfig") {}

/** Isolates the retained product environment contract from the generic tool implementation. */
export const defaultConfigLayer = Layer.sync(ConfigService, () =>
  ConfigService.of({
    provider:
      process.env.OPENCODE_WEBSEARCH_PROVIDER === "exa" || process.env.OPENCODE_WEBSEARCH_PROVIDER === "parallel"
        ? process.env.OPENCODE_WEBSEARCH_PROVIDER
        : undefined,
    enableExa: truthy("OPENCODE_EXPERIMENTAL") || truthy("OPENCODE_ENABLE_EXA") || truthy("OPENCODE_EXPERIMENTAL_EXA"),
    enableParallel: truthy("OPENCODE_ENABLE_PARALLEL") || truthy("OPENCODE_EXPERIMENTAL_PARALLEL"),
    exaApiKey: process.env.EXA_API_KEY,
    parallelApiKey: process.env.PARALLEL_API_KEY,
  }),
)

export const configNode = makeLocationNode({ service: ConfigService, layer: defaultConfigLayer, deps: [] })

/** Official leftover ToolRegistry.webSearchEnabled. Isolated to avoid registry ↔ websearch cycles. */
export function webSearchEnabled(
  providerID: string,
  flags: { readonly exa?: boolean; readonly parallel?: boolean } = {},
) {
  return providerID === "opencode" || flags.exa === true || flags.parallel === true
}
