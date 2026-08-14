export * as Prewarm from "./prewarm"

import { LLM, type LLMClientShape, type LLMRequest, type Model } from "@opencode-ai/llm"
import { Effect } from "effect"
import { PromptTape } from "./prompt-tape"

const ALLOWED = new Set([
  "opencode-go:deepseek-v4-flash",
  "opencode:deepseek-v4-flash",
  "opencode:deepseek-v4-flash-free",
])

export const isAllowlisted = (model: Model) => ALLOWED.has(`${model.provider}:${model.id}`)

export const prewarmRequest = (model: Model, tape: PromptTape.Tape): LLMRequest =>
  LLM.request({
    model,
    system: tape.system,
    messages: [],
    compiled: PromptTape.compiled(tape),
    generation: { maxTokens: 1, temperature: 0 },
  })

/** Fire-and-forget system+tools KV warm. Never writes a user onto the tape. */
export const prewarmIfAllowed = (llm: LLMClientShape, model: Model, tape: PromptTape.Tape) => {
  if (!isAllowlisted(model)) return Effect.void
  return llm.generate(prewarmRequest(model, tape)).pipe(Effect.catchCause(() => Effect.void), Effect.asVoid)
}
