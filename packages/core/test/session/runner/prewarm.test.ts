import { describe, expect, test } from "bun:test"
import { Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { PromptTape } from "@opencode-ai/core/session/runner/prompt-tape"
import { isAllowlisted, prewarmRequest } from "@opencode-ai/core/session/runner/prewarm"

const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })
const goFlash = Model.make({ id: "deepseek-v4-flash", provider: "opencode-go", route: OpenAIChat.route })

describe("prewarm", () => {
  test("prewarm compiled messages are system only", () => {
    const tape = PromptTape.origin({
      system: "S",
      tools: [{ type: "function", function: { name: "echo", description: "e", parameters: {} } }],
    })
    const request = prewarmRequest(model, tape)
    expect(request.compiled!.messages).toEqual([{ role: "system", content: "S" }])
    expect(request.compiled!.messages.some((message) => (message as { role: string }).role === "user")).toBe(false)
    expect(request.generation?.maxTokens).toBe(1)
  })

  test("only Go/Zen Flash models are allowlisted", () => {
    expect(isAllowlisted(model)).toBe(false)
    expect(isAllowlisted(goFlash)).toBe(true)
    expect(isAllowlisted(Model.make({ id: "deepseek-v4-flash", provider: "opencode", route: OpenAIChat.route }))).toBe(
      true,
    )
    expect(
      isAllowlisted(Model.make({ id: "deepseek-v4-flash-free", provider: "opencode", route: OpenAIChat.route })),
    ).toBe(true)
    expect(isAllowlisted(Model.make({ id: "deepseek-chat", provider: "opencode-go", route: OpenAIChat.route }))).toBe(
      false,
    )
  })
})
