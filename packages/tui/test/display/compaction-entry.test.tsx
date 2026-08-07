/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { Renderable, RGBA } from "@opentui/core"
import type { FilePart } from "@opencode-ai/sdk/v2"
import { testRender } from "@opentui/solid"
// Side effect: Flock.setGlobal() so KVProvider's async lock can settle.
import "@opencode-ai/core/global"
import { CompactionEntry } from "../../src/display/CompactionEntry"
import { ThemeProvider } from "../../src/context/theme"
import { TuiConfigProvider, type Resolved } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { TuiPathsProvider } from "../../src/context/runtime"
import { pinGroupVersion } from "../../src/display/pin-store"

const MESSAGE_ID = "msg_compaction_entry"
const SUMMARY = "compacted summary line"
const WIDTH = 80
const HEIGHT = 24
// Right-aligned action target occupies the last columns of the header row.
const ACTION_HIT_X = WIDTH - 1

const config = {
  genericToolOutput: false,
  showDetails: false,
  groupToolVerbs: true,
  diffStyle: "auto",
  scrollSpeed: 1,
  scrollAcceleration: 1,
  thinking: { streaming: "truncated", finished: "collapsed" },
} as unknown as Resolved

// Real-time polling: the test renderer's waitFor(maxPasses) can give up before
// async provider init (KV lock/read) and Solid signal flips settle.
async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function findAnchors() {
  return [...Renderable.renderablesByNumber.values()].filter((item) => item.id === MESSAGE_ID)
}

function anchor() {
  const found = findAnchors()
  expect(found).toHaveLength(1)
  return found[0]
}

async function renderEntry(overrides: {
  summary?: string
  files?: FilePart[]
  onMouseUp?: () => void
} = {}) {
  const onMouseUp = overrides.onMouseUp ?? (() => {})
  // Unique state dir per instance keeps the KV flock key uncontended.
  const state = `/tmp/opencode/compaction-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const app = await testRender(
    () => (
      <TuiPathsProvider value={{ cwd: "/tmp", home: "/tmp", state, worktree: "/tmp" }}>
        <KVProvider>
          <TuiConfigProvider config={config}>
            <ThemeProvider mode="dark">
              <CompactionEntry
                messageID={MESSAGE_ID}
                marginTop={0}
                summary={overrides.summary ?? SUMMARY}
                files={overrides.files ?? []}
                queued={false}
                created={0}
                showTimestamp={false}
                color={RGBA.fromInts(100, 100, 100, 255)}
                onMouseUp={onMouseUp}
                registerAnchor={() => {}}
              />
            </ThemeProvider>
          </TuiConfigProvider>
        </KVProvider>
      </TuiPathsProvider>
    ),
    { width: WIDTH, height: HEIGHT },
  )
  // Wait for both registration AND layout: renderables register at creation,
  // but x/y/width/height only settle after a layout pass.
  await wait(() => {
    const found = findAnchors()
    return found.length === 1 && found[0].height === 1 && found[0].width > 0
  })
  return { app, onMouseUp }
}

async function clickDivider(app: { mockMouse: { pressDown: Function; release: Function } }) {
  const entry = anchor()
  const x = entry.x + Math.floor(entry.width / 2)
  const y = entry.y
  await app.mockMouse.pressDown(x, y)
  await app.mockMouse.release(x, y)
}

describe("CompactionEntry", () => {
  test("starts collapsed: divider header only, no summary body", async () => {
    const { app } = await renderEntry()
    try {
      expect(anchor().height).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("a valid click on the divider expands the summary; a second click collapses it", async () => {
    const { app } = await renderEntry()
    try {
      await clickDivider(app)
      await wait(() => anchor().height > 1)
      const expanded = anchor()
      expect(expanded.height).toBeGreaterThan(1)
      await clickDivider(app)
      await wait(() => anchor().height === 1)
      expect(anchor().height).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("drag beyond the click threshold does not toggle", async () => {
    const { app } = await renderEntry()
    try {
      const entry = anchor()
      const x = entry.x + Math.floor(entry.width / 2)
      await app.mockMouse.pressDown(x, entry.y)
      await app.mockMouse.emitMouseEvent("drag", x + 5, entry.y)
      await app.mockMouse.release(x + 5, entry.y)
      await Bun.sleep(50)
      expect(anchor().height).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("releasing away from the divider does not toggle", async () => {
    const { app } = await renderEntry()
    try {
      const entry = anchor()
      const x = entry.x + Math.floor(entry.width / 2)
      await app.mockMouse.pressDown(x, entry.y)
      await app.mockMouse.moveTo(0, HEIGHT - 1)
      // Release away from the target: press-release blocks because the press
      // and release did not land on the same cell. (Mid-press mouseout disarm
      // itself is covered by test/display/press-release.test.ts.)
      await app.mockMouse.release(0, HEIGHT - 1)
      await Bun.sleep(50)
      expect(anchor().height).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("empty summary still expands to a render-safe body", async () => {
    const { app } = await renderEntry({ summary: "" })
    try {
      expect(anchor().height).toBe(1)
      await clickDivider(app)
      await wait(() => anchor().height > 1)
      expect(anchor().height).toBeGreaterThan(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("empty summary with files renders the file chips when expanded", async () => {
    const filePart = {
      id: "prt_notes",
      sessionID: "ses_x",
      messageID: MESSAGE_ID,
      type: "file",
      mime: "text/plain",
      url: "notes.txt",
    } satisfies FilePart
    const { app } = await renderEntry({ summary: "", files: [filePart] })
    try {
      await clickDivider(app)
      await app.waitForFrame((frame) => frame.includes("notes.txt"))
    } finally {
      app.renderer.destroy()
    }
  })

  test("the stable anchor exists exactly once in both states", async () => {
    const { app } = await renderEntry()
    try {
      await clickDivider(app)
      await wait(() => anchor().height > 1)
      expect(findAnchors()).toHaveLength(1)
      expect(anchor().height).toBeGreaterThan(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("clicking the action target opens the actions path without toggling the fold", async () => {
    let opened = 0
    const { app } = await renderEntry({ onMouseUp: () => (opened += 1) })
    try {
      const entry = anchor()
      await app.mockMouse.pressDown(entry.x + ACTION_HIT_X, entry.y)
      await app.mockMouse.release(entry.x + ACTION_HIT_X, entry.y)
      await wait(() => opened === 1)
      expect(opened).toBe(1)
      expect(anchor().height).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("action-target drag or release-away does not open the actions path", async () => {
    let opened = 0
    const { app } = await renderEntry({ onMouseUp: () => (opened += 1) })
    try {
      const entry = anchor()
      const x = entry.x + ACTION_HIT_X
      await app.mockMouse.pressDown(x, entry.y)
      await app.mockMouse.emitMouseEvent("drag", x - 10, entry.y)
      await app.mockMouse.release(x - 10, entry.y)
      await Bun.sleep(50)
      expect(opened).toBe(0)
      await app.mockMouse.pressDown(x, entry.y)
      await app.mockMouse.moveTo(0, HEIGHT - 1)
      await app.mockMouse.release(0, HEIGHT - 1)
      await Bun.sleep(50)
      expect(opened).toBe(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("clicking the divider does not open the actions path", async () => {
    let opened = 0
    const { app } = await renderEntry({ onMouseUp: () => (opened += 1) })
    try {
      await clickDivider(app)
      await wait(() => anchor().height > 1)
      expect(opened).toBe(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("expanded summary body click opens the actions path and stays expanded", async () => {
    let opened = 0
    const { app } = await renderEntry({ onMouseUp: () => (opened += 1) })
    try {
      await clickDivider(app)
      await wait(() => anchor().height > 1)
      const expanded = anchor()
      const x = expanded.x + Math.floor(expanded.width / 2)
      await app.mockMouse.pressDown(x, expanded.y + 3)
      await app.mockMouse.release(x, expanded.y + 3)
      await wait(() => opened === 1)
      expect(opened).toBe(1)
      expect(anchor().height).toBeGreaterThan(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("folding does not bump the global pin group version", async () => {
    const { app } = await renderEntry()
    try {
      const before = pinGroupVersion()
      await clickDivider(app)
      await wait(() => anchor().height > 1)
      await clickDivider(app)
      await wait(() => anchor().height === 1)
      expect(pinGroupVersion()).toBe(before)
    } finally {
      app.renderer.destroy()
    }
  })

  test("fold state resets when the message id at this position changes", async () => {
    const [messageID, setMessageID] = createSignal(MESSAGE_ID)
    const app = await testRender(
      () => (
        <TuiPathsProvider value={{ cwd: "/tmp", home: "/tmp", state: `/tmp/opencode/reset-${Date.now()}`, worktree: "/tmp" }}>
          <KVProvider>
            <TuiConfigProvider config={config}>
              <ThemeProvider mode="dark">
                <CompactionEntry
                  messageID={messageID()}
                  marginTop={0}
                  summary={SUMMARY}
                  files={[]}
                  queued={false}
                  created={0}
                  showTimestamp={false}
                  color={RGBA.fromInts(100, 100, 100, 255)}
                  onMouseUp={() => {}}
                  registerAnchor={() => {}}
                />
              </ThemeProvider>
            </TuiConfigProvider>
          </KVProvider>
        </TuiPathsProvider>
      ),
      { width: WIDTH, height: HEIGHT },
    )
    try {
      await wait(() => {
        const found = [...Renderable.renderablesByNumber.values()].filter((item) => item.id === MESSAGE_ID)
        return found.length === 1 && found[0].height === 1
      })
      await clickDivider(app)
      await wait(() => {
        const found = [...Renderable.renderablesByNumber.values()].filter((item) => item.id === MESSAGE_ID)
        return found.length === 1 && found[0].height > 1
      })
      setMessageID("msg_compaction_replacement")
      await wait(() => {
        const found = [...Renderable.renderablesByNumber.values()].filter(
          (item) => item.id === "msg_compaction_replacement",
        )
        return found.length === 1 && found[0].height === 1
      })
      expect(
        [...Renderable.renderablesByNumber.values()].filter((item) => item.id === "msg_compaction_replacement"),
      ).toHaveLength(1)
    } finally {
      app.renderer.destroy()
    }
  })
})
