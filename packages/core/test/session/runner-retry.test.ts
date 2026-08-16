import { describe, expect, test } from "bun:test"
import { SessionRetry } from "@opencode-ai/core/session/runner/retry"
import { OverflowContinue } from "@opencode-ai/core/session/overflow-continue"
import { webSearchEnabled } from "@opencode-ai/core/tool/websearch"
import { ZodMetadata } from "@opencode-ai/core/tool/zod-metadata"
import { copilotTotalNanoAiu } from "@opencode-ai/core/session/runner/publish-llm-event"
import { GitLabWorkflow } from "@opencode-ai/core/session/gitlab-workflow"
import { z } from "zod"

describe("SessionRetry", () => {
  test("caps delay at 30s without headers", () => {
    expect(SessionRetry.delay(5)).toBe(30_000)
  })

  test("honors retry-after seconds", () => {
    expect(SessionRetry.delay(1, { responseHeaders: { "retry-after": "12" } })).toBe(12_000)
  })

  test("maps FreeUsageLimitError to Go upsell", () => {
    const retry = SessionRetry.retryable(
      { data: { isRetryable: true, responseBody: "FreeUsageLimitError", message: "free" } },
      "opencode",
    )
    expect(retry?.message).toBe(SessionRetry.GO_UPSELL_MESSAGE)
    expect(retry?.action?.link).toBe(SessionRetry.GO_UPSELL_URL)
  })

  test("retries 5xx even when isRetryable is false", () => {
    expect(
      SessionRetry.retryable({ data: { isRetryable: false, statusCode: 503, message: "down" } }, "test"),
    ).toEqual({ message: "down" })
  })

  test("retries plain rate-limit text", () => {
    expect(SessionRetry.retryable({ data: { message: "rate limit exceeded" } }, "test")?.message).toBe(
      "rate limit exceeded",
    )
  })
})

describe("OverflowContinue", () => {
  test("injects media overflow explanation", () => {
    expect(OverflowContinue.continueText(true)).toContain("attachments were too large")
    expect(OverflowContinue.continueText(false)).toBe(OverflowContinue.CONTINUE_TEXT)
  })

  test("replays last user with media stripped to placeholders", () => {
    expect(
      OverflowContinue.replayUserText({
        text: "what is in this image?",
        files: [{ mime: "image/png", name: "shot.png" }, { mime: "text/plain", name: "note.txt" }],
      }),
    ).toBe("what is in this image?\n[Attached image/png: shot.png]")
    expect(OverflowContinue.hasReplayableMedia([{ mime: "image/jpeg" }])).toBe(true)
    expect(OverflowContinue.hasReplayableMedia([{ mime: "text/plain" }])).toBe(false)
  })
})

describe("webSearchEnabled", () => {
  test("opencode provider or flags enable search", () => {
    expect(webSearchEnabled("opencode")).toBe(true)
    expect(webSearchEnabled("anthropic")).toBe(false)
    expect(webSearchEnabled("anthropic", { exa: true })).toBe(true)
  })
})

describe("copilot billing", () => {
  test("extracts copilot_usage.total_nano_aiu", () => {
    expect(copilotTotalNanoAiu({ copilot_usage: { total_nano_aiu: 12 } })).toBe(12)
    expect(copilotTotalNanoAiu({ response: { copilot_usage: { total_nano_aiu: 3 } } })).toBe(3)
    expect(copilotTotalNanoAiu({})).toBeUndefined()
  })
})

describe("GitLabWorkflow slot", () => {
  test("installs and uninstalls the live host", () => {
    const host = {
      sessionID: "ses_test",
      systemPrompt: "sys",
      sessionPreapprovedTools: ["bash"],
      runPromise: async <A>(effect: never) => effect as A,
      toolExecutor: () => undefined as never,
      approvalHandler: () => undefined as never,
    } as unknown as GitLabWorkflow.Host
    GitLabWorkflow.install(host)
    expect(GitLabWorkflow.current("ses_test")?.systemPrompt).toBe("sys")
    GitLabWorkflow.uninstall("ses_test")
    expect(GitLabWorkflow.current("ses_test")).toBeUndefined()
  })
})

describe("ZodMetadata", () => {
  test("keeps field descriptions", () => {
    const schema = z.object({
      query: z.string().describe("search query"),
    })
    const json = ZodMetadata.toJsonSchema(schema)
    const properties = json.properties as Record<string, { description?: string }>
    expect(properties.query?.description).toBe("search query")
  })
})
