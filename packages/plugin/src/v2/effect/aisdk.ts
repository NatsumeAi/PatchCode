import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { ModelInfo } from "@opencode-ai/sdk/api/types"
import type { Hooks } from "./registration.js"

export type AISDKHooks = Hooks<{
  sdk: {
    readonly model: ModelInfo
    readonly package: string
    readonly options: Record<string, any>
    sdk?: any
  }
  language: {
    readonly model: ModelInfo
    readonly sdk: any
    readonly options: Record<string, any>
    language?: LanguageModelV3
  }
}>
