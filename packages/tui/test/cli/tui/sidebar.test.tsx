/** @jsxImportSource @opentui/solid */
import { Renderable, RGBA, type MouseEvent as TuiMouseEvent } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Show } from "solid-js"
import { expect, test } from "bun:test"
import { RESIZE_HANDLE_WIDTH } from "../../../src/util/sidebar-layout"
import { SidebarResizeHandle } from "../../../src/routes/session/sidebar-resize-handle"
import { createSidebarLayoutState, type SidebarLayoutState } from "../../../src/routes/session/sidebar-layout-state"

async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function findRenderable(id: string) {
  return [...Renderable.renderablesByNumber.values()].find((item) => item.id === id)
}

function renderableColor(renderable: Renderable) {
  return String((renderable as unknown as { borderColor: unknown }).borderColor)
}

function LayoutHarness(input: {
  width: number
  visible: boolean
  mainDownCalls?: string[]
  onReady: (api: { layout: SidebarLayoutState; persisted: number[] }) => void
}) {
  const persisted: number[] = []
  const layout = createSidebarLayoutState({
    terminalWidth: () => input.width,
    visible: () => input.visible,
    storedWidth: () => 42,
    ready: () => true,
    persist: (width) => persisted.push(width),
  })
  input.onReady({ layout, persisted })
  const base = RGBA.fromInts(100, 100, 100, 255)
  const active = RGBA.fromInts(200, 0, 0, 255)
  const handle = (onStart: (event: TuiMouseEvent) => void, onDrag: (event: TuiMouseEvent) => void) => (
    <SidebarResizeHandle
      color={base}
      activeColor={active}
      onStart={onStart}
      onDrag={onDrag}
      onEnd={() => layout.endResize()}
    />
  )
  return (
    <box flexDirection="row" flexGrow={1} minHeight={0}>
      <box flexGrow={1} minHeight={0} onMouseDown={() => input.mainDownCalls?.push("main-down")}>
        <text>main</text>
      </box>
      <Show when={layout.layout().mode === "dock" && layout.layout().handleVisible}>
        {handle(
          (event) => layout.beginResize(event.x),
          (event) => layout.updateResize(event.x),
        )}
        <box width={layout.layout().effectiveWidth} height="100%" backgroundColor={RGBA.fromInts(60, 60, 60, 255)} />
      </Show>
      <Show when={layout.layout().mode === "overlay" && layout.layout().handleVisible}>
        <box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          alignItems="flex-end"
          justifyContent="flex-end"
          backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
        >
          <box flexDirection="row" height="100%" flexShrink={0}>
            {handle(
              (event) => layout.beginResize(event.x),
              (event) => layout.updateResize(event.x),
            )}
            <box width={layout.layout().effectiveWidth} height="100%" backgroundColor={RGBA.fromInts(60, 60, 60, 255)} />
          </box>
        </box>
      </Show>
    </box>
  )
}

async function mountLayout(input: { width: number; visible?: boolean; mainDownCalls?: string[] }) {
  let api!: { layout: SidebarLayoutState; persisted: number[] }
  const app = await testRender(
    () => (
      <LayoutHarness
        width={input.width}
        visible={input.visible ?? true}
        mainDownCalls={input.mainDownCalls}
        onReady={(value) => {
          api = value
        }}
      />
    ),
    { width: input.width, height: 24 },
  )
  await app.flush()
  return { app, api: api! }
}

test("handle occupies two columns with the initial boundary color", async () => {
  const base = RGBA.fromInts(100, 100, 100, 255)
  const app = await testRender(
    () => (
      <SidebarResizeHandle color={base} activeColor={RGBA.fromInts(200, 0, 0, 255)} onStart={() => {}} onDrag={() => {}} onEnd={() => {}} />
    ),
    { width: 80, height: 24 },
  )
  try {
    await app.waitFor(() => Boolean(findRenderable("sidebar-resize-handle")))
    const handle = findRenderable("sidebar-resize-handle")!
    expect(handle.width).toBe(RESIZE_HANDLE_WIDTH)
    expect(handle.height).toBe(24)
    expect(renderableColor(handle)).toBe(String(base))
  } finally {
    app.renderer.destroy()
  }
})

test("handle reports hover color and clears it on out", async () => {
  const base = RGBA.fromInts(100, 100, 100, 255)
  const active = RGBA.fromInts(200, 0, 0, 255)
  const app = await testRender(
    () => (
      <SidebarResizeHandle color={base} activeColor={active} onStart={() => {}} onDrag={() => {}} onEnd={() => {}} />
    ),
    { width: 80, height: 24 },
  )
  try {
    await app.waitFor(() => Boolean(findRenderable("sidebar-resize-handle")))
    const handle = findRenderable("sidebar-resize-handle")!
    await app.mockMouse.moveTo(0, 5)
    await wait(() => renderableColor(handle) === String(active))
    await app.mockMouse.moveTo(50, 5)
    await wait(() => renderableColor(handle) === String(base))
  } finally {
    app.renderer.destroy()
  }
})

test("handle fires start, drag, and exactly one end for press, drag, release", async () => {
  const calls: string[] = []
  const app = await testRender(
    () => (
      <SidebarResizeHandle
        color={RGBA.fromInts(100, 100, 100, 255)}
        activeColor={RGBA.fromInts(200, 0, 0, 255)}
        onStart={() => calls.push("start")}
        onDrag={() => calls.push("drag")}
        onEnd={() => calls.push("end")}
      />
    ),
    { width: 80, height: 24 },
  )
  try {
    await app.waitFor(() => Boolean(findRenderable("sidebar-resize-handle")))
    await app.mockMouse.pressDown(0, 5)
    await app.mockMouse.emitMouseEvent("drag", 0, 5)
    await app.mockMouse.emitMouseEvent("drag", 20, 5)
    await app.mockMouse.release(20, 5)
    await wait(() => calls.filter((item) => item === "end").length === 1)
    expect(calls).toEqual(["start", "drag", "drag", "end"])
  } finally {
    app.renderer.destroy()
  }
})

test("handle stops propagation to sibling renderables", async () => {
  const mainCalls: string[] = []
  const app = await testRender(
    () => (
      <box flexDirection="row" width={80} height={24}>
        <box flexGrow={1} onMouseDown={() => mainCalls.push("main-down")}>
          <text>main</text>
        </box>
        <SidebarResizeHandle
          color={RGBA.fromInts(100, 100, 100, 255)}
          activeColor={RGBA.fromInts(200, 0, 0, 255)}
          onStart={() => {}}
          onDrag={() => {}}
          onEnd={() => {}}
        />
      </box>
    ),
    { width: 80, height: 24 },
  )
  try {
    await app.waitFor(() => Boolean(findRenderable("sidebar-resize-handle")))
    await app.mockMouse.pressDown(79, 5)
    await app.mockMouse.emitMouseEvent("drag", 70, 5)
    await app.mockMouse.release(70, 5)
    await Bun.sleep(50)
    expect(mainCalls).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("dock mode renders the rail at the requested width and drags persist once", async () => {
  const { app, api } = await mountLayout({ width: 120 })
  try {
    expect(api.layout.layout().mode).toBe("dock")
    expect(api.layout.layout().effectiveWidth).toBe(42)
    expect(api.layout.layout().mainContentWidth).toBe(72)
    await app.waitFor(() => findRenderable("sidebar-resize-handle")?.x === 120 - 42 - RESIZE_HANDLE_WIDTH)
    const handle = findRenderable("sidebar-resize-handle")!
    expect(handle.x).toBe(120 - 42 - RESIZE_HANDLE_WIDTH)

    await app.mockMouse.pressDown(76, 10)
    await app.mockMouse.emitMouseEvent("drag", 76, 10)
    await app.mockMouse.emitMouseEvent("drag", 66, 10)
    await app.mockMouse.release(66, 10)
    await wait(() => api.layout.requestedWidth() === 52)
    expect(api.layout.layout().effectiveWidth).toBe(52)
    expect(api.persisted).toEqual([52])
  } finally {
    app.renderer.destroy()
  }
})

test("overlay mode keeps the full main width and drags adjust the rail", async () => {
  const { app, api } = await mountLayout({ width: 118 })
  try {
    expect(api.layout.layout().mode).toBe("overlay")
    expect(api.layout.layout().mainContentWidth).toBe(114)
    expect(api.layout.layout().effectiveWidth).toBe(42)
    await app.waitFor(() => findRenderable("sidebar-resize-handle")?.x === 118 - 42 - RESIZE_HANDLE_WIDTH)
    const handle = findRenderable("sidebar-resize-handle")!
    expect(handle.x).toBe(118 - 42 - RESIZE_HANDLE_WIDTH)

    await app.mockMouse.pressDown(74, 10)
    await app.mockMouse.emitMouseEvent("drag", 74, 10)
    await app.mockMouse.emitMouseEvent("drag", 64, 10)
    await app.mockMouse.release(64, 10)
    await wait(() => api.layout.requestedWidth() === 52)
    expect(api.layout.layout().mainContentWidth).toBe(114)
    expect(api.layout.layout().effectiveWidth).toBe(52)
    expect(api.persisted).toEqual([52])
  } finally {
    app.renderer.destroy()
  }
})

test("hidden mode renders no handle and no rail", async () => {
  const { app, api } = await mountLayout({ width: 120, visible: false })
  try {
    expect(api.layout.layout().mode).toBe("hidden")
    expect(api.layout.layout().handleVisible).toBe(false)
    expect(findRenderable("sidebar-resize-handle")).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("handle drags never reach the main pane", async () => {
  const mainDownCalls: string[] = []
  const { app } = await mountLayout({ width: 120, mainDownCalls })
  try {
    await app.mockMouse.pressDown(76, 10)
    await app.mockMouse.emitMouseEvent("drag", 76, 10)
    await app.mockMouse.emitMouseEvent("drag", 66, 10)
    await app.mockMouse.release(66, 10)
    await Bun.sleep(50)
    expect(mainDownCalls).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})
