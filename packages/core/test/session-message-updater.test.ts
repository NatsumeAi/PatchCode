import { expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"

const sessionID = SessionV2.ID.make("ses_first_token")
const assistantMessageID = SessionMessage.ID.make("msg_assistant")
const model = {
  id: ModelV2.ID.make("model"),
  providerID: ProviderV2.ID.make("provider"),
}

const apply = (state: SessionMessageUpdater.MemoryState, event: SessionEvent.Event) =>
  Effect.runSync(SessionMessageUpdater.update(SessionMessageUpdater.memory(state), event))

test("text.started stamps assistant.time.first once", () => {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  apply(state, {
    id: EventV2.ID.create(),
    type: "session.next.step.started",
    data: {
      sessionID,
      assistantMessageID,
      timestamp: DateTime.makeUnsafe(0),
      agent: "build",
      model,
    },
  })
  apply(state, {
    id: EventV2.ID.create(),
    type: "session.next.text.started",
    data: {
      sessionID,
      assistantMessageID,
      timestamp: DateTime.makeUnsafe(320),
      textID: "t0",
    },
  })
  apply(state, {
    id: EventV2.ID.create(),
    type: "session.next.reasoning.started",
    data: {
      sessionID,
      assistantMessageID,
      timestamp: DateTime.makeUnsafe(400),
      reasoningID: "r0",
    },
  })

  const assistant = state.messages[0]
  expect(assistant?.type).toBe("assistant")
  if (assistant?.type !== "assistant") return
  expect(assistant.time.first === undefined ? undefined : DateTime.toEpochMillis(assistant.time.first)).toBe(320)
})
