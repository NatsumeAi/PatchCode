export * as VariantPlugin from "./variant"

import type { ModelInfo } from "@opencode-ai/sdk/api/types"
import { Effect } from "effect"
import { define } from "./internal"

/**
 * Variants are projected from models.dev `reasoning_options` in ModelsDevPlugin
 * (data-driven — no per-model hardcoding). This plugin is retained as a no-op
 * transform hook so external plugins / tests that depend on the `variant`
 * plugin id keep loading; it no longer invents model-specific variants.
 */
export const Plugin = define({
  id: "variant",
  effect: Effect.fn(function* (_ctx) {
    // intentionally empty — see ModelsDevPlugin.applyModel for effort variants
  }),
})

/** @deprecated Variants come from models.dev reasoning_options; always returns []. */
export function generate(_model: ModelInfo): ModelInfo["variants"] {
  return []
}
