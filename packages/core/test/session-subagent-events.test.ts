import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionEvent } from "../src/session/event"
import { DateTime } from "effect"

describe("SessionEvent.Subagent", () => {
  test("Started event decodes with child/parent/subagentType", () => {
    const event = {
      id: "evt_test",
      type: "session.next.subagent.started",
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: "ses_parent",
        childSessionID: "ses_child",
        subagentType: "explore",
        parentSessionID: "ses_parent",
      },
    }
    const decoded = Schema.decodeUnknownSync(SessionEvent.Subagent.Started)(event)
    expect(decoded.data.childSessionID).toBe("ses_child")
    expect(decoded.data.subagentType).toBe("explore")
  })

  test("Completed event decodes with output and resumeFrom", () => {
    const event = {
      id: "evt_test",
      type: "session.next.subagent.completed",
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: "ses_parent",
        childSessionID: "ses_child",
        subagentType: "explore",
        output: "done",
        resumeFrom: "ses_child",
      },
    }
    const decoded = Schema.decodeUnknownSync(SessionEvent.Subagent.Completed)(event)
    expect(decoded.data.output).toBe("done")
    expect(decoded.data.resumeFrom).toBe("ses_child")
  })

  test("Failed event decodes with error", () => {
    const event = {
      id: "evt_test",
      type: "session.next.subagent.failed",
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: "ses_parent",
        childSessionID: "ses_child",
        subagentType: "explore",
        error: "boom",
        resumeFrom: "ses_child",
      },
    }
    const decoded = Schema.decodeUnknownSync(SessionEvent.Subagent.Failed)(event)
    expect(decoded.data.error).toBe("boom")
  })

  test("HeartbeatLost event decodes", () => {
    const event = {
      id: "evt_test",
      type: "session.next.subagent.heartbeat_lost",
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: "ses_parent",
        childSessionID: "ses_child",
      },
    }
    const decoded = Schema.decodeUnknownSync(SessionEvent.Subagent.HeartbeatLost)(event)
    expect(decoded.data.childSessionID).toBe("ses_child")
  })

  test("Completed is durable, Started is live-only", () => {
    expect(SessionEvent.Subagent.Completed.durable).toBeDefined()
    expect(SessionEvent.Subagent.Failed.durable).toBeDefined()
    expect(SessionEvent.Subagent.Started.durable).toBeUndefined()
    expect(SessionEvent.Subagent.HeartbeatLost.durable).toBeUndefined()
  })
})
