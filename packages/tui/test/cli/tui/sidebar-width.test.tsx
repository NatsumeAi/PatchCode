/** @jsxImportSource @opentui/solid */
import { Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { Sidebar } from "../../../src/routes/session/sidebar"
import { KVProvider, useKV } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { SDKProvider } from "../../../src/context/sdk"
import { ProjectProvider } from "../../../src/context/project"
import { PermissionProvider } from "../../../src/context/permission"
import { ArgsProvider } from "../../../src/context/args"
import { ExitProvider } from "../../../src/context/exit"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { PluginRuntimeProvider, createPluginRuntime } from "../../../src/plugin/runtime"
import { TuiConfigProvider } from "../../../src/config"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { tmpdir } from "../../fixture/fixture"

async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function findScrollBox() {
  return [...Renderable.renderablesByNumber.values()].find((item) => item.constructor.name === "ScrollBoxRenderable")
}

const sessionData = {
  id: "ses_test",
  projectID: "proj_test",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  title: "Test session",
  location: { directory },
}

async function mountSidebar(input: { width: number }) {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([sessionData])
    if (url.pathname === "/session/ses_test") return json(sessionData)
    if (["/session/ses_test/message", "/session/ses_test/todo", "/session/ses_test/diff"].includes(url.pathname))
      return json([])
    return undefined
  }, events)

  let kv!: ReturnType<typeof useKV>
  let sync!: ReturnType<typeof useSync>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Harness() {
    kv = useKV()
    sync = useSync()
    onMount(() => {
      void sync.session.sync("ses_test").then(done)
    })
    return (
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box flexGrow={1} minHeight={0}>
          <text>main</text>
        </box>
        <Sidebar sessionID="ses_test" width={input.width} />
      </box>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state }}>
        <TuiConfigProvider config={createTuiResolvedConfig({})}>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
              <ArgsProvider>
                <PermissionProvider>
                  <ProjectProvider>
                    <ExitProvider exit={() => {}}>
                      <SyncProvider>
                        <ThemeProvider mode="dark">
                          <PluginRuntimeProvider value={createPluginRuntime()}>
                            <Harness />
                          </PluginRuntimeProvider>
                        </ThemeProvider>
                      </SyncProvider>
                    </ExitProvider>
                  </ProjectProvider>
                </PermissionProvider>
              </ArgsProvider>
            </SDKProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 160, height: 24 },
  )
  await ready
  await wait(() => Boolean(findScrollBox()))
  await app.flush()
  return { app, kv, sync }
}

test("Sidebar shell width follows the width prop", async () => {
  const { app } = await mountSidebar({ width: 56 })
  try {
    const scrollbox = findScrollBox()!
    const shell = scrollbox.parent!
    expect(shell.width).toBe(56)
  } finally {
    app.renderer.destroy()
  }
})

test("Sidebar keeps its own scrollbox with an independent scrollbar", async () => {
  const { app, kv } = await mountSidebar({ width: 42 })
  try {
    const scrollbox = findScrollBox()!
    expect((scrollbox as unknown as { verticalScrollBar: unknown }).verticalScrollBar).toBeDefined()
    // The main scrollbar preference must not disable the rail scrollbar.
    kv.set("scrollbar_visible", false)
    await app.flush()
    expect((findScrollBox()! as unknown as { verticalScrollBar: unknown }).verticalScrollBar).toBeDefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a very wide sidebar shell renders without shrinking the main pane", async () => {
  const { app } = await mountSidebar({ width: 64 })
  try {
    const scrollbox = findScrollBox()!
    expect(scrollbox.parent!.width).toBe(64)
  } finally {
    app.renderer.destroy()
  }
})
