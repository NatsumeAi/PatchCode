import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { extractSessionMeta } from "../../src/memory/session-meta"
import { testEffect } from "../lib/effect"

const sessionID = SessionSchema.ID.make("ses_meta_test")
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const user = (text: string, id: string) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.make(id),
    type: "user",
    text,
    time: { created: DateTime.makeUnsafe(0) },
  })
const assistant = (id: string) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: "build",
    model,
    content: [],
    time: { created: DateTime.makeUnsafe(0) },
  })

const store = Layer.succeed(
  SessionStore.Service,
  SessionStore.Service.of({
    context: () =>
      Effect.succeed([user("first question", "msg_m1"), assistant("msg_m2"), user("second question", "msg_m3")]),
    get: () => Effect.die("unused"),
    sessionPermission: () => Effect.die("unused"),
    runnerContext: () => Effect.die("unused"),
    message: () => Effect.die("unused"),
    wait: () => Effect.die("unused"),
  }),
)

const it = testEffect(store)

describe("Session metadata", () => {
  it.effect("extracts counts and topics", () =>
    Effect.gen(function* () {
      const meta = yield* extractSessionMeta(yield* SessionStore.Service, sessionID)
      expect(meta.userPrompts).toBe(2)
      expect(meta.assistantMessages).toBe(1)
      expect(meta.topics).toEqual(["first question", "second question"])
      expect(meta.userTextBytes).toBe("first questionsecond question".length)
      expect(meta.toolResults).toBe(0)
      expect(meta.sessionID).toBe(String(sessionID))
    }),
  )

  it.effect("skips empty user messages and caps topics", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 8 }, (_, i) => user(`topic number ${i}`, `msg_t${i}`))
      const layered = Layer.succeed(
        SessionStore.Service,
        SessionStore.Service.of({
          context: () => Effect.succeed([...many, user("   ", "msg_empty")]),
          get: () => Effect.die("unused"),
          sessionPermission: () => Effect.die("unused"),
          runnerContext: () => Effect.die("unused"),
          message: () => Effect.die("unused"),
          wait: () => Effect.die("unused"),
        }),
      )
      const meta = yield* Effect.gen(function* () {
        const store = yield* SessionStore.Service
        return yield* extractSessionMeta(store, sessionID)
      }).pipe(Effect.provide(layered))
      expect(meta.userPrompts).toBe(8)
      expect(meta.topics.length).toBe(5)
    }),
  )
})
