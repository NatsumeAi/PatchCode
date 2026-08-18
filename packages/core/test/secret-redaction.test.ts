import { afterEach, describe, expect, test } from "bun:test"
import {
  redactSecrets,
  redactUnknown,
  registerSecretValue,
  resetSecretsForTests,
} from "@opencode-ai/core/secret-redaction"

describe("secret redaction", () => {
  afterEach(() => {
    resetSecretsForTests()
  })

  test("skips short values", () => {
    registerSecretValue("short")
    expect(redactSecrets("short secret")).toBe("short secret")
  })

  test("redacts raw, url-encoded, and json-escaped variants", () => {
    const key = "sk-test-secret-value-12345"
    registerSecretValue(key)
    expect(redactSecrets(`token ${key} end`)).toBe("token [REDACTED] end")
    expect(redactSecrets(`q=${encodeURIComponent(key)}`)).toBe("q=[REDACTED]")
    const quoted = JSON.stringify({ key })
    expect(redactSecrets(quoted)).not.toContain(key)
    expect(redactSecrets(quoted)).toContain("[REDACTED]")
  })

  test("redactUnknown walks tool-shaped output", () => {
    const key = "sk-live-tool-output-abcdef"
    registerSecretValue(key)
    const out = redactUnknown({
      structured: { token: key },
      content: [{ type: "text", text: `got ${key}` }],
    })
    expect(JSON.stringify(out)).not.toContain(key)
    expect(JSON.stringify(out)).toContain("[REDACTED]")
  })
})
