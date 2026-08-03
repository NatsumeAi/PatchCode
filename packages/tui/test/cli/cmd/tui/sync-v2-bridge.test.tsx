/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_v2_bridge"
const userID = "msg_user_bridge"
const assistantID = "msg_asst_bridge"
const session = {
  id: sessionID,
  title: "bridge",
  time: { created: 0, updated: 0 },
  version: "local",
  directory: "/tmp/opencode/packages/opencode",
  agent: "build",
  model: { id: "deepseek-v4-flash-free", providerID: "opencode", variant: "high" },
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: session.directory, project: "proj_test", payload }
}

test("session.next events paint V1 message/parts for TUI render store", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    // Seed session metadata so metaFor() has agent/model/directory
    emit(
      global({
        id: "evt_session",
        type: "session.updated",
        properties: { sessionID, info: session as never },
      }),
    )
    await wait(() => !!sync.session.get(sessionID))

    emit(
      global({
        id: "evt_prompted",
        type: "session.next.prompted",
        properties: {
          timestamp: 1000,
          sessionID,
          messageID: userID,
          prompt: { text: "你好" },
          delivery: "queue",
        },
      }),
    )
    await wait(() => (sync.data.message[sessionID] ?? []).some((m) => m.id === userID))
    expect(sync.data.message[sessionID]?.find((m) => m.id === userID)?.role).toBe("user")
    expect(sync.data.part[userID]?.[0]).toMatchObject({ type: "text", text: "你好" })

    emit(
      global({
        id: "evt_step",
        type: "session.next.step.started",
        properties: {
          timestamp: 1100,
          sessionID,
          assistantMessageID: assistantID,
          agent: "build",
          model: { id: "deepseek-v4-flash-free", providerID: "opencode", variant: "high" },
        },
      }),
    )
    await wait(() => (sync.data.message[sessionID] ?? []).some((m) => m.id === assistantID))

    emit(
      global({
        id: "evt_text_start",
        type: "session.next.text.started",
        properties: {
          timestamp: 1200,
          sessionID,
          assistantMessageID: assistantID,
          textID: "t0",
        },
      }),
    )
    emit(
      global({
        id: "evt_text_delta",
        type: "session.next.text.delta",
        properties: {
          timestamp: 1201,
          sessionID,
          assistantMessageID: assistantID,
          textID: "t0",
          delta: "DSV4",
        },
      }),
    )
    emit(
      global({
        id: "evt_text_delta2",
        type: "session.next.text.delta",
        properties: {
          timestamp: 1202,
          sessionID,
          assistantMessageID: assistantID,
          textID: "t0",
          delta: "-OK",
        },
      }),
    )
    await wait(() => {
      const part = sync.data.part[assistantID]?.find((p) => p.type === "text")
      return part?.type === "text" && part.text === "DSV4-OK"
    })

    emit(
      global({
        id: "evt_step_end",
        type: "session.next.step.ended",
        properties: {
          timestamp: 1300,
          sessionID,
          assistantMessageID: assistantID,
          finish: "stop",
          cost: 0,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      }),
    )
    await wait(() => {
      const msg = sync.data.message[sessionID]?.find((m) => m.id === assistantID)
      return msg?.role === "assistant" && !!msg.time.completed
    })

    const assistant = sync.data.message[sessionID]?.find((m) => m.id === assistantID)
    expect(assistant?.role).toBe("assistant")
    if (assistant?.role === "assistant") {
      expect(assistant.parentID).toBe(userID)
      expect(assistant.finish).toBe("stop")
    }
  } finally {
    app.renderer.destroy()
  }
})
