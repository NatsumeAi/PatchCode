export * as MemoryConfig from "./config"

import { Effect, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import {
  DEFAULT_EMBEDDING_API_BASE,
  embeddingProviderFromConfig,
  type EmbeddingProvider,
} from "./embedding"

export { DEFAULT_EMBEDDING_API_BASE }

export interface MemoryEmbeddingConfig {
  readonly model: string
  readonly apiBase: string
  readonly apiKey?: string
  readonly dimensions: number
}

/**
 * Reads optional embedding config from env.
 * - OPENCODE_MEMORY_EMBEDDING_MODEL (required to enable hybrid)
 * - OPENCODE_MEMORY_EMBEDDING_API_BASE (optional)
 * - OPENCODE_MEMORY_EMBEDDING_API_KEY (optional)
 * - OPENCODE_MEMORY_EMBEDDING_DIMENSIONS (optional, default 1024)
 */
export function memoryEmbeddingEnvConfig(): MemoryEmbeddingConfig | undefined {
  const model = process.env.OPENCODE_MEMORY_EMBEDDING_MODEL?.trim()
  if (!model) return undefined
  const dimensionsRaw = process.env.OPENCODE_MEMORY_EMBEDDING_DIMENSIONS?.trim()
  const parsed = dimensionsRaw ? Number(dimensionsRaw) : 1024
  return {
    model,
    apiBase: process.env.OPENCODE_MEMORY_EMBEDDING_API_BASE?.trim() || DEFAULT_EMBEDDING_API_BASE,
    apiKey: process.env.OPENCODE_MEMORY_EMBEDDING_API_KEY?.trim() || undefined,
    dimensions: Number.isFinite(parsed) && parsed > 0 ? parsed : 1024,
  }
}

/**
 * Resolves an embedding provider from env config, or None when unset.
 * Provides a fetch-based HttpClient so callers need not wire HTTP deps.
 */
export const resolveMemoryEmbeddingProvider = Effect.fn("Memory.resolveMemoryEmbeddingProvider")(function* () {
  const config = memoryEmbeddingEnvConfig()
  if (!config) return Option.none<EmbeddingProvider>()
  return yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* embeddingProviderFromConfig(config, client)
  }).pipe(Effect.provide(FetchHttpClient.layer))
})
