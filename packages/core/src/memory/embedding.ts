import { Effect, Option, Schedule, Schema } from "effect"
import { HttpClient, HttpBody } from "effect/unstable/http"

export class EmbeddingError extends Schema.TaggedErrorClass<EmbeddingError>()("Memory.EmbeddingError", {
  message: Schema.String,
}) {}

export interface EmbeddingProvider {
  readonly embedBatch: (texts: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbeddingError>
  readonly dimensions: () => number
  readonly model: () => string
}

const MAX_BATCH = 32

/** OpenAI-compatible `/embeddings` client with batching and retry. */
export function openAIEmbeddingProvider(input: {
  apiBase: string
  apiKey?: string
  model: string
  dimensions: number
  client: HttpClient.HttpClient
}): EmbeddingProvider {
  const url = `${input.apiBase.replace(/\/$/, "")}/embeddings`
  const request = (batch: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbeddingError> =>
    Effect.gen(function* () {
      const body = yield* HttpBody.json({ model: input.model, input: batch })
      const response = yield* input.client.post(url, {
        headers: {
          "content-type": "application/json",
          ...(input.apiKey !== undefined ? { authorization: `Bearer ${input.apiKey}` } : {}),
        },
        body,
      })
      if (response.status !== 200) return yield* new EmbeddingError({ message: `HTTP ${response.status}` })
      const parsed = yield* response.json.pipe(
        Effect.mapError(() => new EmbeddingError({ message: "invalid response body" })),
      )
      const data = (parsed as { data?: Array<{ embedding?: unknown }> }).data
      if (!Array.isArray(data)) return yield* new EmbeddingError({ message: "missing data" })
      return data.map((item) => (Array.isArray(item.embedding) ? (item.embedding as number[]) : ([] as number[])))
    }).pipe(
      Effect.retry({
        times: 3,
        schedule: Schedule.exponential("1 seconds"),
      }),
      Effect.catchTag("HttpClientError", () => Effect.fail(new EmbeddingError({ message: "request failed" }))),
      Effect.catchTag("HttpBodyError", () => Effect.fail(new EmbeddingError({ message: "body failed" }))),
    )
  return {
    embedBatch: (texts) =>
      Effect.forEach(
        Array.from({ length: Math.ceil(texts.length / MAX_BATCH) }, (_, i) =>
          texts.slice(i * MAX_BATCH, (i + 1) * MAX_BATCH),
        ),
        request,
        { concurrency: 1 },
      ).pipe(Effect.map((batches) => batches.flat())),
    dimensions: () => input.dimensions,
    model: () => input.model,
  }
}

/** Default OpenAI-compatible embeddings base when config omits apiBase. */
export const DEFAULT_EMBEDDING_API_BASE = "https://api.openai.com/v1"

/**
 * Builds a provider from config; None when the model is unset.
 * The vector tier is optional (architecture P7): callers pass the provider
 * into openMemoryIndex when OPENCODE_MEMORY_EMBEDDING_MODEL (or equivalent
 * config) is set. Until then the FTS path is the default.
 */
export const embeddingProviderFromConfig = Effect.fn("Memory.embeddingProviderFromConfig")(function* (
  config: { model?: string; dimensions?: number; apiBase?: string; apiKey?: string },
  client: HttpClient.HttpClient,
) {
  const model = config.model?.trim()
  if (!model) return Option.none<EmbeddingProvider>()
  return Option.some(
    openAIEmbeddingProvider({
      apiBase: (config.apiBase?.trim() || DEFAULT_EMBEDDING_API_BASE).replace(/\/$/, ""),
      apiKey: config.apiKey,
      model,
      dimensions: config.dimensions ?? 1024,
      client,
    }),
  )
})