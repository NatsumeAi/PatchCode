import { AISDK } from "@opencode-ai/core/aisdk"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Model } from "@opencode-ai/core/model"
import { Plugin } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { ProviderPlugins } from "@opencode-ai/core/plugin/provider"
import { OpenRouterPlugin } from "@opencode-ai/core/plugin/provider/openrouter"
import { Provider } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpenRouterPlugin.effect(host)
})

describe("OpenRouterPlugin", () => {
  it.effect("is registered so legacy OpenRouter behavior can be applied", () =>
    Effect.sync(() => expect(ProviderPlugins.map((item) => item.id)).toContain(Plugin.ID.make("openrouter"))),
  )

  it.effect("applies legacy referer headers only to openrouter", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(Provider.ID.openrouter, (provider) => {
          provider.api = { type: "aisdk", package: "@openrouter/ai-sdk-provider" }
          provider.request = { headers: { Existing: "value" }, body: {} }
        })
        catalog.provider.update(Provider.ID.make("nvidia"), () => {})
      })
      yield* addPlugin()

      expect((yield* catalog.provider.get(Provider.ID.openrouter))?.request.headers).toEqual({
        Existing: "value",
        "HTTP-Referer": "https://opencode.ai/",
        "X-Title": "opencode",
      })
      expect((yield* catalog.provider.get(Provider.ID.make("nvidia")))?.request.headers).toEqual({})
    }),
  )

  it.effect("creates an SDK only for the OpenRouter package", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()

      const ignored = yield* aisdk.runSDK({
        model: Model.Info.make({
          ...Model.Info.empty(Provider.ID.openrouter, Model.ID.make("openai/gpt-5")),
          api: { id: Model.ID.make("openai/gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "openrouter" },
      })
      expect(ignored.sdk).toBeUndefined()

      const result = yield* aisdk.runSDK({
        model: Model.Info.make({
          ...Model.Info.empty(Provider.ID.make("custom"), Model.ID.make("openai/gpt-5")),
          api: { id: Model.ID.make("openai/gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        package: "@openrouter/ai-sdk-provider",
        options: { name: "custom" },
      })
      expect(result.sdk).toBeDefined()
    }),
  )

  it.effect("filters OpenRouter's gpt-5 chat alias", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(Provider.ID.openrouter, (provider) => {
          provider.api = { type: "aisdk", package: "@openrouter/ai-sdk-provider" }
        })
        catalog.provider.update(Provider.ID.openai, () => {})
        catalog.model.update(Provider.ID.openrouter, Model.ID.make("openai/gpt-5-chat"), () => {})
        catalog.model.update(Provider.ID.openrouter, Model.ID.make("openai/gpt-5"), () => {})
        catalog.model.update(Provider.ID.openai, Model.ID.make("openai/gpt-5-chat"), () => {})
      })
      yield* addPlugin()

      expect((yield* catalog.model.get(Provider.ID.openrouter, Model.ID.make("openai/gpt-5-chat")))?.enabled).toBe(
        false,
      )
      expect((yield* catalog.model.get(Provider.ID.openrouter, Model.ID.make("openai/gpt-5")))?.enabled).toBe(true)
      expect((yield* catalog.model.get(Provider.ID.openai, Model.ID.make("openai/gpt-5-chat")))?.enabled).toBe(true)
    }),
  )

  it.effect("does not disable gpt-5-chat-latest for non-OpenRouter providers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(Provider.ID.make("custom-openrouter"), () => {})
        catalog.model.update(Provider.ID.make("custom-openrouter"), Model.ID.make("gpt-5-chat-latest"), () => {})
      })
      yield* addPlugin()
      expect(
        (yield* catalog.model.get(Provider.ID.make("custom-openrouter"), Model.ID.make("gpt-5-chat-latest")))
          ?.enabled,
      ).toBe(true)
    }),
  )
})
