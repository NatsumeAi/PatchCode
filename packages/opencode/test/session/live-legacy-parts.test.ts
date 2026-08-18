import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk/v2"
import { createLivePartState, leftoverPartsFromLive, liveSessionID } from "@/session/live-legacy-parts"

function event(type: Event["type"], properties: Record<string, unknown>): Event {
  return { id: "evt", type, properties } as Event
}

describe("leftoverPartsFromLive", () => {
  test("maps session.next text deltas before ended", () => {
    const state = createLivePartState()
    const delta = leftoverPartsFromLive(
      event("session.next.text.delta", {
        timestamp: 1,
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        textID: "txt_1",
        delta: "hel",
      }),
      state,
    )
    expect(delta).toEqual([
      expect.objectContaining({
        type: "text",
        text: "hel",
        id: "prt_msg_1_txt_1",
        time: { start: 1 },
      }),
    ])
    expect("end" in (delta[0] as { time?: object }).time!).toBe(false)

    const more = leftoverPartsFromLive(
      event("session.next.text.delta", {
        timestamp: 2,
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        textID: "txt_1",
        delta: "lo",
      }),
      state,
    )
    expect(more[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "hello",
        time: { start: 1 },
      }),
    )

    const ended = leftoverPartsFromLive(
      event("session.next.text.ended", {
        timestamp: 3,
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        textID: "txt_1",
        text: "hello",
      }),
      state,
    )
    expect(ended[0]).toEqual(
      expect.objectContaining({
        type: "text",
        text: "hello",
        time: { start: 1, end: 3 },
      }),
    )
  })

  test("liveSessionID reads session.next text events", () => {
    expect(
      liveSessionID(
        event("session.next.text.delta", {
          sessionID: "ses_live",
          assistantMessageID: "msg",
          textID: "t",
          delta: "x",
          timestamp: 1,
        }),
      ),
    ).toBe("ses_live")
  })
})
