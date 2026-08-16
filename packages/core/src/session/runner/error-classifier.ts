export * as ErrorClassifier from "./error-classifier"

import { Effect, Schema } from "effect"
import { LLMError } from "@opencode-ai/llm"
import { SessionRetry } from "./retry"

/**
 * L2 ErrorClassifier — classifies provider/transport errors into the 19-class
 * FailoverReason enum aligned with hermes `error_classifier.py:24`.
 *
 * Only the 5 well-known signals in opencode's current surface are implemented
 * (429 / 503 / timeout / context_overflow / unknown). The remaining 14 classes
 * match hermes's enum but have no observable trigger in the current code path;
 * Plan 3 Task 5 will wire them from the runner's catch arms.
 *
 * Default is `unknown` fail-closed (non-retryable): follows hermes's principle
 * "在 classifier 不能识别时, 不重试以免风暴."
 */

export const FailoverReason = Schema.Literals([
  "rate_limit",
  "server_unavailable",
  "timeout",
  "token_budget_exceeded",
  "thinking_signature_mismatch",
  "multimodal_tool_content_unparseable",
  "codex_auth_retry",
  "embedding_quota",
  "network_dead",
  "context_overflow",
  "max_iterations_user",
  "max_iterations_loop",
  "guardian_denial",
  "agent_failure",
  "malformed_output",
  "thinking_required_when_disabled",
  "multimodal_unsupported",
  "provider_pool_failover",
  "unknown",
])
export type FailoverReason = typeof FailoverReason.Type

export interface ClassifyResult {
  readonly reason: FailoverReason
  readonly retryable: boolean
  readonly failoverTarget?: string
  readonly action?: SessionRetry.RetryAction
  readonly message?: string
}

interface CauseShape {
  readonly type: string
  readonly status?: number
  readonly message?: string
}

type ClassifyInput = CauseShape | LLMError

const classifyReason = (cause: LLMError): ClassifyResult => {
  switch (cause.reason._tag) {
    case "RateLimit":
      return { reason: "rate_limit", retryable: true }
    case "Authentication":
      return { reason: "codex_auth_retry", retryable: false }
    case "InvalidRequest":
      return cause.reason.classification === "context-overflow"
        ? { reason: "context_overflow", retryable: false }
        : { reason: "unknown", retryable: false }
    case "Transport":
      return cause.reason.kind === "timeout"
        ? { reason: "timeout", retryable: true }
        : { reason: "network_dead", retryable: true }
    case "ProviderInternal":
      return cause.reason.status === 503
        ? { reason: "server_unavailable", retryable: true }
        : { reason: "provider_pool_failover", retryable: true }
    case "QuotaExceeded":
      return { reason: "token_budget_exceeded", retryable: false }
    case "ContentPolicy":
      return { reason: "guardian_denial", retryable: false }
    case "InvalidProviderOutput":
      return { reason: "malformed_output", retryable: false }
    case "NoRoute":
    case "UnknownProvider":
      return { reason: "unknown", retryable: false }
  }
}

const withOfficialRetry = (classified: ClassifyResult, cause: ClassifyInput, provider = "unknown"): ClassifyResult => {
  const err =
    cause instanceof LLMError
      ? {
          data: {
            message: cause.reason.message,
            isRetryable: classified.retryable,
            statusCode:
              "status" in cause.reason && typeof cause.reason.status === "number" ? cause.reason.status : undefined,
            responseBody: cause.reason.message,
          },
        }
      : {
          data: {
            statusCode: cause.status,
            isRetryable: classified.retryable,
            message: cause.message,
            responseBody: cause.message,
          },
        }
  const retry = SessionRetry.retryable(err, provider)
  if (!retry) return classified
  return {
    ...classified,
    retryable: true,
    message: retry.message,
    ...(retry.action ? { action: retry.action } : {}),
  }
}

export const classifyApiError = (cause: ClassifyInput, provider = "unknown"): Effect.Effect<ClassifyResult> =>
  Effect.gen(function* () {
    if (cause instanceof LLMError) return withOfficialRetry(classifyReason(cause), cause, provider)
    if (cause.status === 429) {
      return withOfficialRetry({ reason: "rate_limit", retryable: true }, cause, provider)
    }
    if (cause.status !== undefined && cause.status >= 500) {
      return withOfficialRetry({ reason: "server_unavailable", retryable: true }, cause, provider)
    }
    if (cause.status === 503) {
      return withOfficialRetry({ reason: "server_unavailable", retryable: true }, cause, provider)
    }
    if (cause.type === "timeout") {
      return withOfficialRetry({ reason: "timeout", retryable: true }, cause, provider)
    }
    if (cause.type === "context_overflow") {
      return { reason: "context_overflow", retryable: false }
    }
    const retry = SessionRetry.retryable(
      { data: { message: cause.message, isRetryable: false, responseBody: cause.message } },
      provider,
    )
    if (retry) {
      return { reason: "rate_limit", retryable: true, message: retry.message, ...(retry.action ? { action: retry.action } : {}) }
    }
    return { reason: "unknown", retryable: false }
  })
