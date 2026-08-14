export * as PromptTapeAppend from "./prompt-tape-append"

import type { PromptTape } from "./prompt-tape"

const escapeSystemUpdateText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export const lowerSystemUpdate = (text: string): PromptTape.ChatMessage => ({
  role: "user",
  content: `<system-update>\n${escapeSystemUpdateText(text)}\n</system-update>`,
})

export const lowerAssistantFromStream = (input: {
  readonly text: string | null
  readonly toolCalls: ReadonlyArray<{ readonly id: string; readonly name: string; readonly arguments: string }>
  readonly reasoning?: string
}): PromptTape.ChatMessage => ({
  role: "assistant",
  content: input.text,
  tool_calls:
    input.toolCalls.length === 0
      ? undefined
      : input.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        })),
  ...(input.reasoning ? { reasoning_content: input.reasoning } : {}),
})

export const lowerToolResult = (input: { readonly toolCallId: string; readonly content: string }): PromptTape.ChatMessage => ({
  role: "tool",
  tool_call_id: input.toolCallId,
  content: input.content,
})

export const lowerUser = (input: {
  readonly text: string
  readonly files?: ReadonlyArray<{ readonly uri: string; readonly mime: string; readonly name?: string }>
}): PromptTape.ChatMessage => {
  const files = input.files ?? []
  if (files.length === 0) return { role: "user", content: input.text }
  return {
    role: "user",
    content: [
      { type: "text" as const, text: input.text },
      ...files.map((file) => ({
        type: "image_url" as const,
        image_url: { url: file.uri },
      })),
    ],
  }
}

export const lowerShell = (input: { readonly command: string; readonly output: string }): PromptTape.ChatMessage => ({
  role: "user",
  content: `Shell command: ${input.command}\n\n${input.output}`,
})
