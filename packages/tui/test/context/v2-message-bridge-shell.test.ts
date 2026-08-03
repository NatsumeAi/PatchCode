import { describe, expect, test } from "bun:test"
import { sessionMessageToLegacy, type LegacySessionMeta } from "../../src/context/v2-message-bridge"
import type { SessionMessage } from "@opencode-ai/sdk/v2"

const meta: LegacySessionMeta = {
  agent: "build",
  model: { providerID: "opencode", modelID: "test" },
  directory: "/tmp/proj",
}

describe("sessionMessageToLegacy shell", () => {
  test("shell message becomes bash tool + text parts", () => {
    const message = {
      id: "msg_shell_1",
      type: "shell",
      callID: "call_1",
      command: "echo hi",
      output: "hi\n",
      time: { created: 1_700_000_000_000, completed: 1_700_000_001_000 },
    } as unknown as SessionMessage

    const legacy = sessionMessageToLegacy("ses_1", message, meta)
    expect(legacy).toBeDefined()
    expect(legacy!.info.role).toBe("assistant")
    expect(legacy!.parts).toHaveLength(2)
    const tool = legacy!.parts.find((p) => p.type === "tool")
    expect(tool).toBeDefined()
    if (tool?.type === "tool") {
      expect(tool.tool).toBe("bash")
      expect(tool.state.status).toBe("completed")
      if (tool.state.status === "completed") {
        expect(tool.state.input).toEqual({ command: "echo hi" })
        expect(tool.state.output).toBe("hi\n")
        expect(tool.state.metadata.output).toBe("hi\n")
      }
    }
  })
})
