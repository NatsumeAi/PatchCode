import { expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { Event as CoreEvent } from "@opencode-ai/core/event"
import { Model } from "@opencode-ai/core/model"
import { Provider } from "@opencode-ai/core/provider"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"

const sessionID = Session.ID.make("ses_first_token")
const assistantMessageID = SessionMessage.ID.make("msg_assistant")
const model = {
  id: Model.ID.make("model"),
  providerID: Provider.ID.make("provider"),
}

const apply = (state: SessionMessageUpdater.MemoryState, event: SessionEvent.Event) =>
  Effect.runSync(SessionMessageUpdater.update(SessionMessageUpdater.memory(state), event))

test("text.started stamps assistant.time.first once", () => {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  apply(state, {
    id: CoreEvent.ID.create(),
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
    id: CoreEvent.ID.create(),
    type: "session.next.text.started",
    data: {
      sessionID,
      assistantMessageID,
      timestamp: DateTime.makeUnsafe(320),
      textID: "t0",
    },
  })
  apply(state, {
    id: CoreEvent.ID.create(),
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
