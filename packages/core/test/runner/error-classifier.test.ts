import { describe, expect } from "bun:test"
import {
  AuthenticationReason,
  InvalidRequestReason,
  InvalidProviderOutputReason,
  LLMError,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
} from "@opencode-ai/llm"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { classifyApiError, FailoverReason } from "../../src/session/runner/error-classifier"
import { TurnRetryState } from "../../src/session/runner/turn-retry-state"
import { Layer } from "effect"

const layer = Layer.provide(TurnRetryState.layerForTest, TurnRetryState.layerForTest).pipe(
  Layer.merge(TurnRetryState.layerForTest),
)

const it = testEffect(layer)

describe("classifyApiError", () => {
  it.effect("classify 429 as rate_limit (retryable)", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError({ type: "http_error", status: 429 })
      expect(out.reason).toBe("rate_limit")
      expect(out.retryable).toBe(true)
    }),
  )

  it.effect("classify 503 as server_unavailable (retryable)", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError({ type: "http_error", status: 503 })
      expect(out.reason).toBe("server_unavailable")
      expect(out.retryable).toBe(true)
    }),
  )

  it.effect("classify timeout by type", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError({ type: "timeout" })
      expect(out.reason).toBe("timeout")
      expect(out.retryable).toBe(true)
    }),
  )

  it.effect("classify context_overflow (non-retryable)", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError({ type: "context_overflow" })
      expect(out.reason).toBe("context_overflow")
      expect(out.retryable).toBe(false)
    }),
  )

  it.effect("unknown cause → unknown reason, fail-closed", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError({ type: "weird_error" })
      expect(out.reason).toBe("unknown")
      expect(out.retryable).toBe(false)
    }),
  )

  it.effect("returns reason from FailoverReason enum (type-narrow)", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError({ type: "http_error", status: 429 })
      const reasons: FailoverReason[] = ["rate_limit"]
      expect(reasons).toContain(out.reason)
    }),
  )

  it.effect("classifies a real LLM RateLimit reason", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError(
        new LLMError({
          module: "LLM",
          method: "stream",
          reason: new RateLimitReason({ message: "slow down" }),
        }),
      )
      expect(out.reason).toBe("rate_limit")
      expect(out.retryable).toBe(true)
    }),
  )

  it.effect("classifies real auth, context, and timeout reasons", () =>
    Effect.gen(function* () {
      const auth = yield* classifyApiError(
        new LLMError({
          module: "LLM",
          method: "stream",
          reason: new AuthenticationReason({ message: "expired", kind: "expired" }),
        }),
      )
      const context = yield* classifyApiError(
        new LLMError({
          module: "LLM",
          method: "stream",
          reason: new InvalidRequestReason({ message: "context", classification: "context-overflow" }),
        }),
      )
      const timeout = yield* classifyApiError(
        new LLMError({
          module: "LLM",
          method: "stream",
          reason: new TransportReason({ message: "request timed out", kind: "timeout" }),
        }),
      )
      expect(auth.reason).toBe("codex_auth_retry")
      expect(context.reason).toBe("context_overflow")
      expect(timeout.reason).toBe("timeout")
    }),
  )

  it.effect("non-timeout Transport → network_dead (retryable)", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError(
        new LLMError({
          module: "LLM",
          method: "stream",
          reason: new TransportReason({ message: "conn refused", kind: "connection" }),
        }),
      )
      expect(out.reason).toBe("network_dead")
      expect(out.retryable).toBe(true)
    }),
  )

  it.effect("InvalidProviderOutput → malformed_output (non-retryable)", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError(
        new LLMError({
          module: "LLM",
          method: "stream",
          reason: new InvalidProviderOutputReason({ message: "bad json" }),
        }),
      )
      expect(out.reason).toBe("malformed_output")
      expect(out.retryable).toBe(false)
    }),
  )

  it.effect("503 ProviderInternal → server_unavailable (retryable)", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError(
        new LLMError({
          module: "LLM",
          method: "stream",
          reason: new ProviderInternalReason({ message: "down", status: 503 }),
        }),
      )
      expect(out.reason).toBe("server_unavailable")
      expect(out.retryable).toBe(true)
    }),
  )

  it.effect("non-503 ProviderInternal → provider_pool_failover (retryable)", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError(
        new LLMError({
          module: "LLM",
          method: "stream",
          reason: new ProviderInternalReason({ message: "500", status: 500 }),
        }),
      )
      expect(out.reason).toBe("provider_pool_failover")
      expect(out.retryable).toBe(true)
    }),
  )

  it.effect("QuotaExceeded → token_budget_exceeded (non-retryable)", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError(
        new LLMError({
          module: "LLM",
          method: "stream",
          reason: new QuotaExceededReason({ message: "quota" }),
        }),
      )
      expect(out.reason).toBe("token_budget_exceeded")
      expect(out.retryable).toBe(false)
    }),
  )

  it.effect("non-context InvalidRequest → unknown (fail-closed non-retryable)", () =>
    Effect.gen(function* () {
      const out = yield* classifyApiError(
        new LLMError({
          module: "LLM",
          method: "stream",
          reason: new InvalidRequestReason({ message: "bad req" }),
        }),
      )
      expect(out.reason).toBe("unknown")
      expect(out.retryable).toBe(false)
    }),
  )
})

describe("TurnRetryState", () => {
  it.effect("consume(name) returns true on first call, false on second (one-shot)", () =>
    Effect.gen(function* () {
      const first = yield* TurnRetryState.consume("rate_limit")
      expect(first).toBe(true)
      const second = yield* TurnRetryState.consume("rate_limit")
      expect(second).toBe(false)
    }),
  )

  it.effect("different reasons are independently one-shot", () =>
    Effect.gen(function* () {
      expect(yield* TurnRetryState.consume("rate_limit")).toBe(true)
      expect(yield* TurnRetryState.consume("timeout")).toBe(true)
      expect(yield* TurnRetryState.consume("rate_limit")).toBe(false)
      expect(yield* TurnRetryState.consume("timeout")).toBe(false)
    }),
  )

  it.effect("reset clears all one-shot flags so consume returns true again", () =>
    Effect.gen(function* () {
      expect(yield* TurnRetryState.consume("rate_limit")).toBe(true)
      expect(yield* TurnRetryState.consume("rate_limit")).toBe(false)
      yield* TurnRetryState.reset
      expect(yield* TurnRetryState.consume("rate_limit")).toBe(true)
    }),
  )
})
