import { describe, expect } from "bun:test"
import { Catalog } from "@opencode-ai/core/catalog"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { Model } from "@opencode-ai/core/model"
import { VariantPlugin } from "@opencode-ai/core/plugin/variant"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect, Layer } from "effect"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const it = testEffect(AppNodeBuilder.build(Catalog.node, [[Location.node, locationLayer]]))

describe("VariantPlugin", () => {
  it.effect("does not invent per-model variants (models.dev owns effort options)", () =>
    Effect.gen(function* () {
      const service = yield* Catalog.Service
      yield* service.transform((catalog) => {
        catalog.provider.update(Provider.ID.opencode, (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible" }
        })
        catalog.model.update(Provider.ID.opencode, Model.ID.make("glm-5.2"), (model) => {
          model.api = {
            id: Model.ID.make("glm-5.2"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
          }
        })
        catalog.model.update(Provider.ID.opencode, Model.ID.make("deepseek-v4-flash-free"), (model) => {
          model.api = {
            id: Model.ID.make("deepseek-v4-flash-free"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
          }
          // Simulated models-dev projection already present
          model.variants = [
            { id: Model.VariantID.make("high"), headers: {}, body: { reasoning_effort: "high" } },
            { id: Model.VariantID.make("max"), headers: {}, body: { reasoning_effort: "max" } },
          ]
        })
      })
      yield* VariantPlugin.Plugin.effect(host({ catalog: catalogHost(service) }))

      // no hardcoded glm synthesis
      expect((yield* service.model.get(Provider.ID.opencode, Model.ID.make("glm-5.2")))?.variants).toEqual([])
      // leaves data-driven variants alone
      expect(
        (yield* service.model.get(Provider.ID.opencode, Model.ID.make("deepseek-v4-flash-free")))?.variants,
      ).toEqual([
        expect.objectContaining({ id: "high", body: { reasoning_effort: "high" } }),
        expect.objectContaining({ id: "max", body: { reasoning_effort: "max" } }),
      ])
      expect(VariantPlugin.generate({} as never)).toEqual([])
    }),
  )
})
