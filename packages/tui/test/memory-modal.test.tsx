/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { tmpdir } from "./fixture/fixture"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createFetch, json } from "./fixture/tui-sdk"
import { TestTuiContexts } from "./fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

test("memory modal lists files and previews the selected one", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const memoryCalls: string[] = []
  const fetchMock = createFetch((url) => {
    console.log("FETCH-URL:", url.pathname)
    if (url.pathname === "/experimental/memory/read") {
      memoryCalls.push(url.pathname)
      return json({ content: "hello memory content", truncated: false })
    }
    if (url.pathname === "/experimental/memory") {
      memoryCalls.push(url.pathname)
      return json([
        { path: "MEMORY.md", name: "MEMORY.md", kind: "workspace" },
        { path: "sessions/2026-08-07-x.md", name: "2026-08-07-x.md", kind: "session" },
      ])
    }
    return undefined
  })

  const [
    { DialogProvider },
    { SDKProvider },
    { ThemeProvider },
    { ToastProvider },
    { KVProvider },
    { TuiConfigProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../src/ui/dialog"),
    import("../src/context/sdk"),
    import("../src/context/theme"),
    import("../src/ui/toast"),
    import("../src/context/kv"),
    import("../src/config"),
    import("../src/keymap"),
  ])
  const { MemoryModal } = await import("../src/memory-modal")

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({})
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <SDKProvider
                url="http://localhost:1"
                fetch={fetchMock.fetch as typeof fetch}
                events={{ subscribe: async () => () => {} }}
              >
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <MemoryModal />
                    </DialogProvider>
                  </ToastProvider>
                </ThemeProvider>
              </SDKProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 24 })
  try {
    await wait(() => memoryCalls.includes("/experimental/memory"))
    await wait(() => memoryCalls.includes("/experimental/memory/read"))
  } finally {
    app.renderer.destroy()
  }
})
