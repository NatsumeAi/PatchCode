export * as PromptTape from "./prompt-tape"

import type { CompiledChat } from "@opencode-ai/llm"
import { isPrefixOf as wireIsPrefixOf, type ChatWire } from "@opencode-ai/llm/cache-prefix"

export type ChatMessage = {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content?: unknown
  readonly tool_calls?: unknown
  readonly tool_call_id?: string
  readonly reasoning_content?: string
}

export type ChatTool = {
  readonly type: "function"
  readonly function: { readonly name: string; readonly description: string; readonly parameters: unknown }
}

export interface Tape {
  readonly system: string
  readonly tools: ReadonlyArray<ChatTool> | undefined
  readonly messages: ReadonlyArray<ChatMessage>
}

const cloneMessages = (messages: ReadonlyArray<ChatMessage>) =>
  messages.map((message) => structuredClone(message)) as ChatMessage[]

export const origin = (input: { readonly system: string; readonly tools: ReadonlyArray<ChatTool> | undefined }): Tape => ({
  system: input.system,
  tools: input.tools === undefined ? undefined : (structuredClone(input.tools) as ChatTool[]),
  messages: [],
})

export const append = (tape: Tape, extra: ReadonlyArray<ChatMessage>): Tape => ({
  system: tape.system,
  tools: tape.tools,
  messages: [...tape.messages, ...cloneMessages(extra)],
})

export const withEphemeral = (tape: Tape, extra: ReadonlyArray<ChatMessage>): Tape => append(tape, extra)

export const wire = (tape: Tape): ChatWire => ({
  tools: tape.tools,
  messages: [{ role: "system", content: tape.system }, ...tape.messages],
})

export const compiled = (tape: Tape, ephemeral: ReadonlyArray<ChatMessage> = []): CompiledChat => ({
  protocol: "openai-compatible-chat",
  messages: [{ role: "system", content: tape.system }, ...tape.messages, ...cloneMessages(ephemeral)],
  tools: tape.tools,
})

export const isPrefixOf = (prev: Tape, next: Tape) => wireIsPrefixOf(wire(prev), wire(next))
