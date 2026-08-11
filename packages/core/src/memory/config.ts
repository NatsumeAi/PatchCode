export * as MemoryConfig from "./config"

import { Effect, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import {
  DEFAULT_EMBEDDING_API_BASE,
  embeddingProviderFromConfig,
  type EmbeddingProvider,
} from "./embedding"

export { DEFAULT_EMBEDDING_API_BASE }
export {
  DEFAULT_DREAM_HOURS,
  DEFAULT_DREAM_POLICY,
  DEFAULT_RECOVERY_THRESHOLD,
} from "./dream-phases"
export type { DreamPhase, PhasePolicy } from "./dream-phases"
import { DEFAULT_DREAM_HOURS, DEFAULT_DREAM_POLICY, DEFAULT_RECOVERY_THRESHOLD } from "./dream-phases"
import { DEFAULT_RECALL_MAX_AGE_DAYS, DEFAULT_RECALL_MIN_SCORE } from "./ranking"

export interface MemoryEmbeddingConfig {
  readonly model: string
  readonly apiBase: string
  readonly apiKey?: string
  readonly dimensions: number
}

/**
 * Reads optional embedding config from env (product surface for hybrid search).
 *
 * | Env | Required | Meaning |
 * |-----|----------|---------|
 * | OPENCODE_MEMORY_EMBEDDING_MODEL | yes to enable | e.g. text-embedding-3-small |
 * | OPENCODE_MEMORY_EMBEDDING_API_BASE | no | OpenAI-compatible base (default api.openai.com/v1) |
 * | OPENCODE_MEMORY_EMBEDDING_API_KEY | no | Bearer token for the embed API |
 * | OPENCODE_MEMORY_EMBEDDING_DIMENSIONS | no | default 1024 |
 *
 * Privacy: enabling hybrid POSTs memory chunk text to apiBase. Prefer a
 * local/self-hosted endpoint when storing secrets in notes.
 *
 * After enabling on an existing install, the next search/reindex backfills
 * vectors for hash/path conflicts that previously had NULL vectors.
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

export function memoryRecallEnvConfig(): { maxAgeDays: number; minScore: number } {
  const maxAgeRaw = process.env.OPENCODE_MEMORY_RECALL_MAX_AGE_DAYS?.trim()
  const minScoreRaw = process.env.OPENCODE_MEMORY_RECALL_MIN_SCORE?.trim()
  const maxAge = maxAgeRaw ? Number(maxAgeRaw) : DEFAULT_RECALL_MAX_AGE_DAYS
  const minScore = minScoreRaw ? Number(minScoreRaw) : DEFAULT_RECALL_MIN_SCORE
  return {
    maxAgeDays: Number.isFinite(maxAge) && maxAge > 0 ? maxAge : DEFAULT_RECALL_MAX_AGE_DAYS,
    minScore: Number.isFinite(minScore) && minScore >= 0 ? minScore : DEFAULT_RECALL_MIN_SCORE,
  }
}

/** How memory injection/citations are surfaced to the model. */
export type CitationsMode = "auto" | "on" | "off"

/**
 * Resolves the memory injection mode from OPENCODE_MEMORY_CITATIONS
 * (trimmed, case-insensitive). Anything other than "on"/"off" falls back to
 * "auto" (current default behavior: summaries always injected, recall when
 * hits, citations in recall bullets).
 */
export function memoryCitationsMode(): CitationsMode {
  const raw = process.env.OPENCODE_MEMORY_CITATIONS?.trim().toLowerCase()
  return raw === "on" || raw === "off" ? raw : "auto"
}

/** Dream-phase intervals in hours; env overrides (OPENCODE_MEMORY_DREAM_*_HOURS) fall back to defaults. */
export function memoryDreamHoursEnvConfig(): { light: number; deep: number; rem: number } {
  const lightRaw = process.env.OPENCODE_MEMORY_DREAM_LIGHT_HOURS?.trim()
  const deepRaw = process.env.OPENCODE_MEMORY_DREAM_DEEP_HOURS?.trim()
  const remRaw = process.env.OPENCODE_MEMORY_DREAM_REM_HOURS?.trim()
  const light = lightRaw ? Number(lightRaw) : DEFAULT_DREAM_HOURS.light
  const deep = deepRaw ? Number(deepRaw) : DEFAULT_DREAM_HOURS.deep
  const rem = remRaw ? Number(remRaw) : DEFAULT_DREAM_HOURS.rem
  return {
    light: Number.isFinite(light) && light > 0 ? light : DEFAULT_DREAM_HOURS.light,
    deep: Number.isFinite(deep) && deep > 0 ? deep : DEFAULT_DREAM_HOURS.deep,
    rem: Number.isFinite(rem) && rem > 0 ? rem : DEFAULT_DREAM_HOURS.rem,
  }
}

/**
 * Dream-policy env overrides (matching memoryRecallEnvConfig's defensive
 * parsing: invalid or non-numeric values fall back to defaults).
 *
 * | Env | Default |
 * |-----|---------|
 * | OPENCODE_MEMORY_DREAM_DEEP_MIN_ACCESS | 3 (deep/rem min access count) |
 * | OPENCODE_MEMORY_DREAM_RECOVERY_HEALTH | 0.35 (recovery health threshold) |
 */
export function memoryDreamPolicyEnvConfig(): { minAccess: number; recoveryThreshold: number } {
  const minAccessRaw = process.env.OPENCODE_MEMORY_DREAM_DEEP_MIN_ACCESS?.trim()
  const recoveryRaw = process.env.OPENCODE_MEMORY_DREAM_RECOVERY_HEALTH?.trim()
  const minAccess = minAccessRaw ? Number(minAccessRaw) : DEFAULT_DREAM_POLICY.minAccess
  const recoveryThreshold = recoveryRaw ? Number(recoveryRaw) : DEFAULT_RECOVERY_THRESHOLD
  return {
    // A negative minAccess would admit every source regardless of access — not
    // a sane operator intent, so fall back.
    minAccess: Number.isFinite(minAccess) && minAccess >= 0 ? minAccess : DEFAULT_DREAM_POLICY.minAccess,
    // Health is [0,1]; a threshold outside that range is a misconfiguration.
    recoveryThreshold:
      Number.isFinite(recoveryThreshold) && recoveryThreshold >= 0 && recoveryThreshold <= 1
        ? recoveryThreshold
        : DEFAULT_RECOVERY_THRESHOLD,
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
