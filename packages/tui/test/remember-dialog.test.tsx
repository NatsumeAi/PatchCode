/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
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

test("remember prompt writes the note via direct remember API", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const rememberBodies: string[] = []
  const sessionPrompts: string[] = []
  const fetchMock = createFetch((url) => {
    if (url.pathname === "/experimental/memory/remember") {
      return json({ filename: "2026-08-10T00-00-00-remember.md" })
    }
    return undefined
  })
  const base = fetchMock.fetch
  const capturingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as RequestInfo, init)
    const method = (request.method ?? init?.method ?? "GET").toUpperCase()
    if (request.url.includes("/experimental/memory/remember") && method === "POST") {
      void request.clone().text().then((text) => rememberBodies.push(text))
    }
    if (request.url.includes("/session/ses_test/message") && method === "POST") {
      void request.clone().text().then((text) => sessionPrompts.push(text))
    }
    return base(request, init)
  }) as typeof fetch

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
  const { RememberPrompt } = await import("../src/remember-dialog")

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({
      keybinds: {
        input_submit: "super+return",
        input_newline: "return,shift+return,alt+return,ctrl+j",
      },
    })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <SDKProvider
                url="http://localhost:1"
                fetch={capturingFetch}
                events={{ subscribe: async () => () => {} }}
              >
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <RememberPrompt sessionID="ses_test" initial="remember to verify with tests" />
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

  const app = await testRender(() => <Harness />, { width: 80, height: 24, kittyKeyboard: true })
  try {
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")
    app.mockInput.pressEnter()
    await wait(() => rememberBodies.length > 0)
    expect(rememberBodies[0]).toContain("remember to verify with tests")
    expect(sessionPrompts.length).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("remember prompt falls back to agent without double-confirm wording when API missing", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const sessionPrompts: string[] = []
  const fetchMock = createFetch((url) => {
    if (url.pathname === "/experimental/memory/remember") {
      return new Response("Not Found", { status: 404 })
    }
    if (url.pathname === "/session/ses_test/prompt" || url.pathname.includes("/session/ses_test/message")) {
      return json({ data: {} })
    }
    return undefined
  })
  const base = fetchMock.fetch
  const capturingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as RequestInfo, init)
    const method = (request.method ?? init?.method ?? "GET").toUpperCase()
    if (request.url.includes("/session/ses_test/message") && method === "POST") {
      void request.clone().text().then((text) => sessionPrompts.push(text))
    }
    // Also capture remember 404 path through base
    return base(request, init)
  }) as typeof fetch

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
  const { RememberPrompt } = await import("../src/remember-dialog")

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({
      keybinds: {
        input_submit: "super+return",
        input_newline: "return,shift+return,alt+return,ctrl+j",
      },
    })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <SDKProvider
                url="http://localhost:1"
                fetch={capturingFetch}
                events={{ subscribe: async () => () => {} }}
              >
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <RememberPrompt sessionID="ses_test" initial="fallback note" />
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

  const app = await testRender(() => <Harness />, { width: 80, height: 24, kittyKeyboard: true })
  try {
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    app.mockInput.pressEnter()
    await wait(() => sessionPrompts.length > 0)
    expect(sessionPrompts[0]).toContain("fallback note")
    expect(sessionPrompts[0]).toContain("memory_add_note")
    expect(sessionPrompts[0]).not.toContain("only after confirming with the user")
  } finally {
    app.renderer.destroy()
  }
})
