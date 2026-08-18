/** @jsxImportSource @opentui/solid */
import { expect, mock, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/api"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

const SESSION_ID = "ses_compaction_nav"
const COMPACT_ID = "msg_compact_nav"
// Long enough to overflow the 30-row viewport so navigation actually scrolls.
const SUMMARY = Array.from({ length: 60 }, (_, i) => `summary line ${i}`).join("\n")
const session = {
  id: SESSION_ID,
  title: "nav",
  time: { created: 0, updated: 0 },
  version: "local",
  directory,
  agent: "build",
  model: { id: "m", providerID: "opencode", variant: "high" },
}

async function wait(fn: () => boolean, timeout = 8000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(20)
  }
}

function findAnchors() {
  return [...Renderable.renderablesByNumber.values()].filter((item) => item.id === COMPACT_ID)
}

function anyScrollbox() {
  return [...Renderable.renderablesByNumber.values()].find((item) => item instanceof ScrollBoxRenderable)
}

function transcriptScrollbox() {
  return [...Renderable.renderablesByNumber.values()].find(
    (item) => item instanceof ScrollBoxRenderable && item.getChildren().some((child) => child.id === COMPACT_ID),
  )
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

async function mountApp() {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${SESSION_ID}`) return json(session)
    if (url.pathname.endsWith("/message") || url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff"))
      return json([])
    return undefined
  })
  let api!: TuiPluginApi
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const { run } = await import("../../../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch: calls.fetch,
      events: events.source,
      args: { continue: true },
      pluginHost: {
        async start(input) {
          api = input.api
          started()
        },
        async dispose() {},
      },
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
  )
  await ready
  return { setup, task, api, events }
}

async function seedCompaction(events: ReturnType<typeof createEventSource>) {
  events.emit(
    global({
      id: "evt_session",
      type: "session.updated",
      properties: { sessionID: SESSION_ID, info: session as never },
    }),
  )
  events.emit(
    global({
      id: "evt_compact",
      type: "session.next.compaction.ended",
      properties: {
        sessionID: SESSION_ID,
        messageID: COMPACT_ID,
        text: SUMMARY,
        reason: "auto",
        timestamp: 2000,
      },
    }),
  )
}

test("compaction message is a collapsed scrollbox anchor that last-user-message navigation finds", async () => {
  const { setup, task, api, events } = await mountApp()
  try {
    await wait(() => !!anyScrollbox())
    await seedCompaction(events)
    await wait(() => {
      const anchors = findAnchors()
      return anchors.length === 1 && anchors[0].height === 1
    })

    const anchor = findAnchors()[0]
    expect(anchor.height).toBe(1)
    const scroll = transcriptScrollbox()!
    expect(scroll.getChildren().filter((child) => child.id === COMPACT_ID)).toHaveLength(1)

    api.keymap.dispatchCommand("session.messages_last_user")
    await wait(() => Math.abs(scroll.y - (anchor.y - 1)) <= 1)
    expect(scroll.y).toBe(anchor.y - 1)
  } finally {
    api.keymap.dispatchCommand("app.exit")
    await task
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("replayed compaction events never duplicate the scrollbox anchor", async () => {
  const { setup, task, api, events } = await mountApp()
  try {
    await wait(() => !!anyScrollbox())
    await seedCompaction(events)
    await wait(() => {
      const anchors = findAnchors()
      return anchors.length === 1 && anchors[0].height === 1
    })
    await seedCompaction(events)
    await wait(() => findAnchors().length === 1)
    expect(findAnchors()).toHaveLength(1)
    expect(transcriptScrollbox()!.getChildren().filter((child) => child.id === COMPACT_ID)).toHaveLength(1)
  } finally {
    api.keymap.dispatchCommand("app.exit")
    await task
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
