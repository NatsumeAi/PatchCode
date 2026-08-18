import type { ModelInfo, ProviderInfo } from "@opencode-ai/sdk/api/types"
import type { Hooks } from "./registration.js"

export interface CatalogProviderRecord {
  readonly provider: ProviderInfo
  readonly models: ReadonlyMap<string, ModelInfo>
}

export interface CatalogDraft {
  readonly provider: {
    list(): readonly CatalogProviderRecord[]
    get(providerID: string): CatalogProviderRecord | undefined
    update(providerID: string, update: (provider: ProviderInfo) => void): void
    remove(providerID: string): void
  }
  readonly model: {
    get(providerID: string, modelID: string): ModelInfo | undefined
    update(providerID: string, modelID: string, update: (model: ModelInfo) => void): void
    remove(providerID: string, modelID: string): void
    readonly default: {
      get(): { providerID: string; modelID: string } | undefined
      set(providerID: string, modelID: string): void
    }
  }
}

export type CatalogHooks = Hooks<{
  transform: CatalogDraft
}>
