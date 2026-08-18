import { AISDK } from "@opencode-ai/core/aisdk"
import { describe, expect, mock } from "bun:test"
import { Effect } from "effect"
import { Model } from "@opencode-ai/core/model"
import { Plugin } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { GatewayPlugin } from "@opencode-ai/core/plugin/provider/gateway"
import { Provider } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const gatewayCalls: Record<string, unknown>[] = []
const vercelGatewayModels = ["anthropic/claude-sonnet-4", "openai/gpt-5", "google/gemini-2.5-pro"]
const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  yield* GatewayPlugin.effect(host)
})

mock.module("@ai-sdk/gateway", () => ({
  createGateway(options: Record<string, unknown>) {
    gatewayCalls.push({ ...options })
    return {
      languageModel(modelID: string) {
        return {
          modelId: modelID,
          provider: options.name,
          specificationVersion: "v3",
        }
      },
    }
  },
}))

describe("GatewayPlugin", () => {
  it.effect("creates a Gateway SDK for @ai-sdk/gateway", () =>
    Effect.gen(function* () {
      gatewayCalls.length = 0
      const plugin = yield* Plugin.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: Model.Info.make({
          ...Model.Info.empty(Provider.ID.make("gateway"), Model.ID.make("model")),
          api: { id: Model.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/gateway",
        options: { name: "gateway" },
      })
      expect(result.sdk).toBeDefined()
      expect(gatewayCalls).toHaveLength(1)
    }),
  )

  it.effect("passes the model providerID as the Gateway SDK name", () =>
    Effect.gen(function* () {
      gatewayCalls.length = 0
      const plugin = yield* Plugin.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()

      const result = yield* aisdk.runSDK({
        model: Model.Info.make({
          ...Model.Info.empty(Provider.ID.make("vercel"), Model.ID.make("anthropic/claude-sonnet-4")),
          api: {
            id: Model.ID.make("anthropic/claude-sonnet-4"),
            type: "aisdk",
            package: "test-provider",
          },
        }),
        package: "@ai-sdk/gateway",
        options: { name: "vercel", apiKey: "test-key" },
      })

      expect(gatewayCalls).toEqual([{ name: "vercel", apiKey: "test-key" }])
      expect(result.sdk.languageModel("anthropic/claude-sonnet-4").provider).toBe("vercel")
    }),
  )

  it.effect("matches Vercel AI Gateway models by their @ai-sdk/gateway package", () =>
    Effect.gen(function* () {
      gatewayCalls.length = 0
      const plugin = yield* Plugin.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()

      for (const modelID of vercelGatewayModels) {
        const ignored = yield* aisdk.runSDK({
          model: Model.Info.make({
            ...Model.Info.empty(Provider.ID.make("vercel"), Model.ID.make(modelID)),
            api: { id: Model.ID.make(modelID), type: "aisdk", package: "test-provider" },
          }),
          package: "@ai-sdk/vercel",
          options: { name: "vercel" },
        })
        expect(ignored.sdk).toBeUndefined()

        const result = yield* aisdk.runSDK({
          model: Model.Info.make({
            ...Model.Info.empty(Provider.ID.make("vercel"), Model.ID.make(modelID)),
            api: { id: Model.ID.make(modelID), type: "aisdk", package: "test-provider" },
          }),
          package: "@ai-sdk/gateway",
          options: { name: "vercel" },
        })
        expect(result.sdk).toBeDefined()
      }

      expect(gatewayCalls).toHaveLength(3)
    }),
  )
})
