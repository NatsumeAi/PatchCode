export * as MemoryFlush from "./flush"

import { Context, Effect, Layer, Stream } from "effect"
import path from "path"
import { LLM, LLMClient, LLMEvent, SystemPart, type LLMClientShape } from "@opencode-ai/llm"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Location } from "../location"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { SessionStore } from "../session/store"
import { SessionSchema } from "../session/schema"
import { SessionRunnerModel } from "../session/runner/model"
import { toLLMMessages } from "../session/runner/to-llm-message"
import { resolveRoots } from "./storage"
import { appendSessionLog } from "./session-logs"
import { scanForThreats } from "./scan"

const FLUSH_SYSTEM =
  "Write a durable markdown summary of this conversation for future reference. Capture: decisions made and their rationale, architectural patterns and preferences, and problem/solution pairs. Discard greetings, small talk, tool-call noise, and session metadata. Structure the output with markdown headings and bullet lists. Output ONLY the markdown summary."

export interface Interface {
  readonly flush: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryFlush") {}

/** Summarizes one session with the LLM and appends the result to the dated session log. */
export const flushSession = Effect.fn("Memory.flushSession")(function* (
  session: SessionSchema.Info,
  store: SessionStore.Interface,
  llm: LLMClientShape,
  models: SessionRunnerModel.Interface,
  fs: FSUtil.Interface,
  global: Global.Interface,
  location: Location.Interface,
) {
  const messages = yield* store.context(session.id).pipe(Effect.catch(() => Effect.succeed([])))
  if (messages.length === 0) return

  const model = yield* models.resolve(session).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!model) return
  const request = LLM.request({
    model,
    system: [SystemPart.make(FLUSH_SYSTEM)],
    messages: toLLMMessages(messages, model),
    tools: [],
  })
  const text = yield* llm.stream(request).pipe(
    Stream.filter(LLMEvent.is.textDelta),
    Stream.map((event) => event.text),
    Stream.mkString,
    Effect.catch(() => Effect.succeed("")),
  )
  const cleaned = text.trim()
  if (cleaned.length === 0) return
  const threatIds = scanForThreats(cleaned)
  if (threatIds.length > 0) {
    yield* Effect.logWarning("memory flush blocked: threat patterns " + threatIds.join(", "))
    return
  }

  const roots = resolveRoots(path.join(global.data, "memory"), location.directory)
  const written = yield* appendSessionLog(fs, roots, String(session.id), new Date(), cleaned)
  if (!written) {
    yield* Effect.logWarning(`memory flush atomic write failed for session ${String(session.id)}`)
  }
})
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const llm = yield* LLMClient.Service
    const models = yield* SessionRunnerModel.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    return Service.of({
      flush: Effect.fn("Memory.flush")(function* (sessionID) {
        const session = yield* Effect.orElseSucceed(store.get(sessionID), () => undefined)
        if (!session) return
        yield* flushSession(session, store, llm, models, fs, global, location).pipe(Effect.catch(() => Effect.void))
      }),
    })
  }),
)

export const node = makeLocationNode({
  name: "memory-flush",
  layer,
  deps: [llmClient, SessionStore.node, SessionRunnerModel.node, FSUtil.node, Location.node, Global.node],
})
