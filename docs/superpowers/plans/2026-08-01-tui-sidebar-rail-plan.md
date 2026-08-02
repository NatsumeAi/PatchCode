# TUI Right Sidebar Rail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a resizable right-side TUI rail with an independent native scrollbar, persisted width, dock/overlay behavior, and keyboard/command-palette controls without changing session or message behavior.

**Architecture:** Keep `Session` as the owner of terminal dimensions, visibility, KV persistence, and the layout tree. Put all width/mode arithmetic in a pure utility, put Solid state transitions in a focused session layout-state module, and keep the resize handle presentational with callbacks. Reuse the existing `Sidebar`, OpenTUI `scrollbox`, `useKV`, theme, and command registration patterns; do not introduce a global layout store or a second sidebar content model.

**Tech Stack:** Bun test, TypeScript with `tsgo`, Solid.js, `@opentui/core` 0.4.5, `@opentui/solid` 0.4.5, `@opentui/keymap` 0.4.5, OpenCode TUI fixtures, and the existing `useKV` persistence layer.

## Global Constraints

- The resize control is a layout boundary, not a model, temperature, context, or execution-parameter slider.
- The right rail is global TUI layout state, not per-session state.
- Default width is `42` columns; normal docked width is clamped to `28`–`64` columns.
- The resize handle is one visible layout column and sits immediately to the left of the right rail.
- Dock mode must preserve at least `72` columns for the main content and account for the current four columns of main-pane horizontal padding.
- Narrow terminals use the existing right-aligned overlay pattern and must not collapse the main content pane.
- The rail keeps its native OpenTUI `scrollbox`; `session.toggle.scrollbar` remains scoped to the main message scrollbar.
- Drag updates are in-memory only; persist exactly once on successful drag completion.
- Cancelled drags discard the draft width and do not write KV.
- Invalid persisted width must not crash rendering; normalize it to the default or legal clamp.
- The prompt, message scroll state, session data, plugin slots, and execution behavior must remain unchanged.
- Use strict TypeScript. Do not add `any`, `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Keep new modules focused and below the repository's 250-line guidance where practical; do not refactor unrelated code in `Session`.
- Tests run from package directories, never from repository root. Run TUI tests from `packages/tui`.
- Do not commit, reset, stash, clean, or modify unrelated dirty work in the current worktree unless the user explicitly requests it.

---

## File Map

The implementation should touch only the following feature files and their focused tests:

### New files

- `packages/tui/src/util/sidebar-layout.ts`
  - Pure constants, width normalization, dock/overlay resolution, main-content width, drag arithmetic, and keyboard step arithmetic.
- `packages/tui/src/routes/session/sidebar-layout-state.ts`
  - Solid state controller that joins persisted width, draft drag width, terminal width, visibility, and persistence callbacks.
- `packages/tui/src/routes/session/sidebar-resize-handle.tsx`
  - One-column visual separator and OpenTUI mouse interaction callbacks.
- `packages/tui/test/util/sidebar-layout.test.ts`
  - Pure layout and boundary tests.
- `packages/tui/test/routes/session/sidebar-layout-state.test.ts`
  - State-controller tests for hydration, drag commit/cancel, keyboard steps, and persistence count.
- `packages/tui/test/cli/tui/sidebar.test.tsx`
  - Real OpenTUI harness for the resize handle plus dock/overlay composition and command behavior.

### Modified files

- `packages/tui/src/routes/session/sidebar.tsx`
  - Replace the hard-coded width with a required `width` prop; preserve all slots, footer, and native scrollbar behavior.
- `packages/tui/src/routes/session/index.tsx`
  - Instantiate the layout state, replace fixed width arithmetic, insert the resize handle, preserve dock/overlay rendering, and register width commands.
- `packages/tui/src/config/keybind.ts`
  - Add the three configurable sidebar width commands and their defaults/descriptions.
- `packages/tui/test/keymap.test.tsx`
  - Verify the new defaults compile into the expected leader sequences and remain discoverable through command bindings.

No generated SDK, server, schema, core session, or unrelated WIP files are part of this feature.

---

## Task 1: Add the pure sidebar layout model

**Files:**

- Create: `packages/tui/src/util/sidebar-layout.ts`
- Test: `packages/tui/test/util/sidebar-layout.test.ts`

**Interfaces:**

```ts
export type SidebarMode = "hidden" | "dock" | "overlay"

export const DEFAULT_SIDEBAR_WIDTH = 42
export const MIN_SIDEBAR_WIDTH = 28
export const MAX_SIDEBAR_WIDTH = 64
export const RESIZE_HANDLE_WIDTH = 1
export const MIN_MAIN_CONTENT_WIDTH = 72
export const MAIN_HORIZONTAL_PADDING = 4
export const OVERLAY_PADDING = 0

export type SidebarLayout = {
  mode: SidebarMode
  requestedWidth: number
  effectiveWidth: number
  mainContentWidth: number
  handleVisible: boolean
}

export function normalizeSidebarWidth(value: unknown): number
export function resolveSidebarLayout(input: {
  terminalWidth: number
  requestedWidth: unknown
  visible: boolean
}): SidebarLayout
export function widthFromDrag(input: {
  startWidth: number
  startX: number
  currentX: number
}): number
export function stepSidebarWidth(width: unknown, delta: -1 | 1): number
```

- [ ] **Step 1: Write failing table-driven tests for width normalization.**

Add cases for `undefined`, `null`, strings, `NaN`, positive infinity, negative infinity, negative numbers, `0`, `28`, `42`, `64`, and values above `64`. The expected behavior is:

```ts
expect(normalizeSidebarWidth(undefined)).toBe(DEFAULT_SIDEBAR_WIDTH)
expect(normalizeSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH)
expect(normalizeSidebarWidth(12)).toBe(MIN_SIDEBAR_WIDTH)
expect(normalizeSidebarWidth(42)).toBe(DEFAULT_SIDEBAR_WIDTH)
expect(normalizeSidebarWidth(90)).toBe(MAX_SIDEBAR_WIDTH)
```

- [ ] **Step 2: Run the focused test and verify it fails for the missing module.**

Run from `packages/tui`:

```bash
bun test test/util/sidebar-layout.test.ts
```

Expected: FAIL because `../../src/util/sidebar-layout` does not yet exist.

- [ ] **Step 3: Implement the pure constants and normalization.**

Use finite-number validation and a numeric clamp. Do not coerce arbitrary strings into numbers; persisted state with a non-number value must fall back to `DEFAULT_SIDEBAR_WIDTH`.

```ts
export const DEFAULT_SIDEBAR_WIDTH = 42
export const MIN_SIDEBAR_WIDTH = 28
export const MAX_SIDEBAR_WIDTH = 64
export const RESIZE_HANDLE_WIDTH = 1
export const MIN_MAIN_CONTENT_WIDTH = 72
export const MAIN_HORIZONTAL_PADDING = 4
export const OVERLAY_PADDING = 0

export function normalizeSidebarWidth(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(value)))
}
```

- [ ] **Step 4: Add failing tests for dock, overlay, hidden, and drag arithmetic.**

The exact expected cases are:

```ts
expect(resolveSidebarLayout({ terminalWidth: 200, requestedWidth: 42, visible: false })).toEqual({
  mode: "hidden",
  requestedWidth: 42,
  effectiveWidth: 0,
  mainContentWidth: 196,
  handleVisible: false,
})

expect(resolveSidebarLayout({ terminalWidth: 120, requestedWidth: 42, visible: true })).toEqual({
  mode: "dock",
  requestedWidth: 42,
  effectiveWidth: 42,
  mainContentWidth: 73,
  handleVisible: true,
})

expect(resolveSidebarLayout({ terminalWidth: 118, requestedWidth: 42, visible: true }).mode).toBe("overlay")
expect(resolveSidebarLayout({ terminalWidth: 118, requestedWidth: 42, visible: true }).mainContentWidth).toBe(114)
expect(widthFromDrag({ startWidth: 42, startX: 100, currentX: 90 })).toBe(52)
expect(widthFromDrag({ startWidth: 42, startX: 100, currentX: 110 })).toBe(32)
expect(stepSidebarWidth(42, 1)).toBe(44)
expect(stepSidebarWidth(42, -1)).toBe(40)
expect(stepSidebarWidth(28, -1)).toBe(28)
expect(stepSidebarWidth(64, 1)).toBe(64)
```

The dock threshold is `72 + 42 + 1 + 4 = 119`, so `119` must dock and `118` must overlay. Verify that a temporary narrow terminal does not mutate `requestedWidth`; only `effectiveWidth` changes.

- [ ] **Step 5: Implement layout resolution and arithmetic.**

Use this decision order:

1. Normalize `requestedWidth`.
2. If `visible` is false, return hidden mode and `terminalWidth - MAIN_HORIZONTAL_PADDING`, clamped at zero.
3. Compute `canDock = terminalWidth >= MIN_MAIN_CONTENT_WIDTH + requestedWidth + RESIZE_HANDLE_WIDTH + MAIN_HORIZONTAL_PADDING`.
4. In dock mode, use the normalized requested width and subtract width, handle, and four columns of main padding.
5. In overlay mode, keep main content at terminal width minus four columns and clamp the rail to the largest positive width that fits, with a one-column lower bound.
6. If the terminal cannot fit even one overlay column, return overlay mode with `effectiveWidth: 0` and `handleVisible: false`; never return a negative dimension.

The implementation shape should be equivalent to:

```ts
export function resolveSidebarLayout(input: {
  terminalWidth: number
  requestedWidth: unknown
  visible: boolean
}): SidebarLayout {
  const requestedWidth = normalizeSidebarWidth(input.requestedWidth)
  const mainContentWidth = Math.max(0, input.terminalWidth - MAIN_HORIZONTAL_PADDING)
  if (!input.visible) {
    return { mode: "hidden", requestedWidth, effectiveWidth: 0, mainContentWidth, handleVisible: false }
  }

  const canDock =
    input.terminalWidth >= MIN_MAIN_CONTENT_WIDTH + requestedWidth + RESIZE_HANDLE_WIDTH + MAIN_HORIZONTAL_PADDING
  if (canDock) {
    return {
      mode: "dock",
      requestedWidth,
      effectiveWidth: requestedWidth,
      mainContentWidth: Math.max(
        0,
        input.terminalWidth - requestedWidth - RESIZE_HANDLE_WIDTH - MAIN_HORIZONTAL_PADDING,
      ),
      handleVisible: true,
    }
  }

  const overlayWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(0, input.terminalWidth - OVERLAY_PADDING))
  return {
    mode: "overlay",
    requestedWidth,
    effectiveWidth: Math.min(requestedWidth, overlayWidth),
    mainContentWidth,
    handleVisible: overlayWidth > 0,
  }
}
```

`widthFromDrag` must only calculate the requested-width candidate; the state controller will clamp it using `normalizeSidebarWidth` before displaying or committing it.

- [ ] **Step 6: Run the pure test suite and typecheck the package.**

Run:

```bash
bun test test/util/sidebar-layout.test.ts
bun typecheck
```

Expected: all layout tests pass and `bun typecheck` exits `0`.

---

## Task 2: Add the Solid sidebar layout state controller

**Files:**

- Create: `packages/tui/src/routes/session/sidebar-layout-state.ts`
- Test: `packages/tui/test/routes/session/sidebar-layout-state.test.ts`

**Interfaces:**

```ts
import type { Accessor } from "solid-js"
import type { SidebarLayout } from "../../util/sidebar-layout"

export type SidebarLayoutStateOptions = {
  terminalWidth: Accessor<number>
  visible: Accessor<boolean>
  storedWidth: Accessor<unknown>
  ready: Accessor<boolean>
  persist: (width: number) => void
}

export type SidebarLayoutState = {
  requestedWidth: Accessor<number>
  draftWidth: Accessor<number | undefined>
  resizing: Accessor<boolean>
  layout: Accessor<SidebarLayout>
  beginResize(startX: number): void
  updateResize(currentX: number): void
  endResize(): void
  cancelResize(): void
  increaseWidth(): void
  decreaseWidth(): void
  resetWidth(): void
}

export function createSidebarLayoutState(options: SidebarLayoutStateOptions): SidebarLayoutState
```

- [ ] **Step 1: Write failing tests inside `createRoot`.**

Use Solid signals for terminal width, visibility, stored width, and readiness. Use an array to record persistence calls. Cover these exact behaviors:

```ts
const persisted: number[] = []
const [terminalWidth, setTerminalWidth] = createSignal(120)
const [visible, setVisible] = createSignal(true)
const [storedWidth, setStoredWidth] = createSignal<unknown>(42)
const [ready, setReady] = createSignal(true)
const state = createSidebarLayoutState({
  terminalWidth,
  visible,
  storedWidth,
  ready,
  persist: (width) => persisted.push(width),
})

expect(state.requestedWidth()).toBe(42)
state.beginResize(100)
state.updateResize(90)
expect(state.draftWidth()).toBe(52)
expect(state.layout().effectiveWidth).toBe(52)
expect(persisted).toEqual([])
state.endResize()
expect(state.requestedWidth()).toBe(52)
expect(persisted).toEqual([52])
```

Also test:

- `cancelResize()` clears the draft, restores the committed width, and leaves persistence empty;
- `beginResize` is idempotent while already resizing;
- `endResize` is idempotent after the first completion;
- terminal shrink changes `layout().mode`/`effectiveWidth` without changing `requestedWidth()`;
- terminal growth restores the requested width;
- `increaseWidth`, `decreaseWidth`, and `resetWidth` persist exactly once per command;
- stored KV hydration is ignored after a local user mutation;
- stored invalid values resolve to `42`.

- [ ] **Step 2: Run the controller test and verify it fails.**

Run from `packages/tui`:

```bash
bun test test/routes/session/sidebar-layout-state.test.ts
```

Expected: FAIL because the controller module does not yet exist.

- [ ] **Step 3: Implement committed width, draft width, and hydration.**

The controller must distinguish the persisted committed width from a drag draft:

```ts
const [requestedWidth, setRequestedWidth] = createSignal(normalizeSidebarWidth(options.storedWidth()))
const [draftWidth, setDraftWidth] = createSignal<number>()
const [resizing, setResizing] = createSignal(false)
const [startX, setStartX] = createSignal<number>()
const [startWidth, setStartWidth] = createSignal<number>()
let locallyMutated = false

createEffect(() => {
  if (locallyMutated || !options.ready()) return
  setRequestedWidth(normalizeSidebarWidth(options.storedWidth()))
})
```

Hydration must only update state while the KV store is not yet superseded by a local command or committed drag. Do not write KV during hydration.

- [ ] **Step 4: Implement the derived layout and resize transitions.**

The active requested value is `draftWidth() ?? requestedWidth()`. The controller must call `resolveSidebarLayout` on every reactive read so terminal changes are reflected immediately.

```ts
const layout = createMemo(() =>
  resolveSidebarLayout({
    terminalWidth: options.terminalWidth(),
    requestedWidth: draftWidth() ?? requestedWidth(),
    visible: options.visible(),
  }),
)

function beginResize(startXValue: number) {
  if (resizing() || !layout().handleVisible) return
  setStartX(startXValue)
  setStartWidth(requestedWidth())
  setDraftWidth(requestedWidth())
  setResizing(true)
}

function updateResize(currentX: number) {
  if (!resizing()) return
  const start = startX()
  const width = startWidth()
  if (start === undefined || width === undefined) return
  setDraftWidth(
    normalizeSidebarWidth(
      widthFromDrag({ startWidth: width, startX: start, currentX }),
    ),
  )
}
```

`endResize` must promote the normalized draft exactly once, call `persist(finalWidth)` exactly once, clear all drag fields, and set `locallyMutated = true`. `cancelResize` must clear all drag fields without changing the committed width or calling `persist`.

- [ ] **Step 5: Implement shared keyboard mutations.**

All three command methods must use one internal commit function:

```ts
function commitWidth(width: unknown) {
  const next = normalizeSidebarWidth(width)
  locallyMutated = true
  setRequestedWidth(next)
  setDraftWidth(undefined)
  options.persist(next)
}

function increaseWidth() {
  commitWidth(stepSidebarWidth(requestedWidth(), 1))
}

function decreaseWidth() {
  commitWidth(stepSidebarWidth(requestedWidth(), -1))
}

function resetWidth() {
  commitWidth(DEFAULT_SIDEBAR_WIDTH)
}
```

Do not persist the effective overlay width; persist the requested width so a later terminal resize can restore the user's preference.

- [ ] **Step 6: Run controller tests and typecheck.**

Run:

```bash
bun test test/routes/session/sidebar-layout-state.test.ts
bun typecheck
```

Expected: all controller tests pass and package typecheck exits `0`.

---

## Task 3: Add the OpenTUI resize handle

**Files:**

- Create: `packages/tui/src/routes/session/sidebar-resize-handle.tsx`
- Test: `packages/tui/test/cli/tui/sidebar.test.tsx`

**Interfaces:**

```ts
import type { ColorInput, MouseEvent } from "@opentui/core"

export type SidebarResizeHandleProps = {
  color: ColorInput
  activeColor: ColorInput
  onStart: (event: MouseEvent) => void
  onDrag: (event: MouseEvent) => void
  onEnd: (event: MouseEvent) => void
}

export function SidebarResizeHandle(props: SidebarResizeHandleProps): JSX.Element
```

- [ ] **Step 1: Add a real OpenTUI harness test for the handle.**

Render the handle inside `testRender`, assign a stable `id="sidebar-resize-handle"`, locate the corresponding `BoxRenderable`, and dispatch typed mouse events through the renderable's registered handlers. Verify:

- the component occupies one layout column and full available height;
- mouse down calls `onStart` once and stops propagation;
- mouse drag calls `onDrag`;
- mouse up or drag end calls `onEnd` once even if OpenTUI emits both terminal events;
- hover/drag state changes the border color to `activeColor`;
- no text input renderable receives the event.

Use the installed `@opentui/core` mouse event type and the test renderer's event dispatch facilities; do not cast to `any` or suppress type errors.

- [ ] **Step 2: Run the focused harness test and verify it fails.**

Run:

```bash
bun test test/cli/tui/sidebar.test.tsx
```

Expected: FAIL because the handle module does not yet exist.

- [ ] **Step 3: Implement the handle as a one-column stateful renderable.**

Use Solid signals for `hovered` and `dragging`. Keep a local `finished` guard so `onMouseUp` and `onMouseDragEnd` cannot double-commit:

```tsx
const [hovered, setHovered] = createSignal(false)
const [dragging, setDragging] = createSignal(false)
let finished = false

const finish = (event: MouseEvent) => {
  event.stopPropagation()
  if (!dragging()) return
  setDragging(false)
  finished = true
  props.onEnd(event)
}

return (
  <box
    id="sidebar-resize-handle"
    width={1}
    flexShrink={0}
    height="100%"
    border={["left"]}
    borderColor={() => (hovered() || dragging() ? props.activeColor : props.color)}
    onMouseOver={() => setHovered(true)}
    onMouseOut={() => {
      if (!dragging()) setHovered(false)
    }}
    onMouseDown={(event) => {
      event.stopPropagation()
      finished = false
      setDragging(true)
      props.onStart(event)
    }}
    onMouseDrag={(event) => {
      event.stopPropagation()
      if (dragging()) props.onDrag(event)
    }}
    onMouseUp={finish}
    onMouseDragEnd={finish}
  />
)
```

If the installed OpenTUI type requires a different border-color accessor shape, preserve the same behavior with the typed JSX API; do not introduce an untyped escape hatch. `finished` must be used to make the `onEnd` callback exactly once per drag.

- [ ] **Step 4: Run the handle harness and package typecheck.**

Run:

```bash
bun test test/cli/tui/sidebar.test.tsx
bun typecheck
```

Expected: handle tests pass and `bun typecheck` exits `0`.

---

## Task 4: Make the existing Sidebar accept a derived width

**Files:**

- Modify: `packages/tui/src/routes/session/sidebar.tsx:12-103`
- Test: `packages/tui/test/cli/tui/sidebar.test.tsx`

**Interfaces:**

Change the public component props from:

```ts
export function Sidebar(props: { sessionID: string; overlay?: boolean })
```

to:

```ts
export function Sidebar(props: { sessionID: string; width: number; overlay?: boolean })
```

- [ ] **Step 1: Add a failing render assertion that the supplied width controls the shell.**

In the existing OpenTUI harness, render `Sidebar` with `width={56}` and verify the root `BoxRenderable` reports width `56`. Render a second instance with `width={28}` and verify it reports `28`. Keep the existing session/plugin fixture data so the test also proves the scrollbox and footer remain present.

- [ ] **Step 2: Change only the shell width and preserve existing sidebar behavior.**

Replace the hard-coded shell prop:

```tsx
<box
  backgroundColor={theme.backgroundPanel}
  width={42}
```

with:

```tsx
<box
  backgroundColor={theme.backgroundPanel}
  width={props.width}
```

Do not move the footer into the scrollbox, remove `verticalScrollbarOptions`, change plugin slot names, or change the existing `overlay` positioning behavior.

- [ ] **Step 3: Run the Sidebar-focused tests and typecheck.**

Run:

```bash
bun test test/cli/tui/sidebar.test.tsx
bun typecheck
```

Expected: width assertions pass, the native sidebar scrollbox remains present, and typecheck exits `0`.

---

## Task 5: Integrate layout state, handle, and dock/overlay rendering into Session

**Files:**

- Modify: `packages/tui/src/routes/session/index.tsx:248-271, 667-735, 1165-1345`
- Modify: `packages/tui/src/routes/session/sidebar.tsx:12-103`
- Test: `packages/tui/test/cli/tui/sidebar.test.tsx`

**Interfaces consumed:**

- `createSidebarLayoutState(options)` from Task 2.
- `SidebarResizeHandle` from Task 3.
- `Sidebar` width prop from Task 4.

- [ ] **Step 1: Add a failing composition harness for dock and overlay modes.**

The harness must use the same structure as the Session route's layout boundary:

```tsx
<box flexDirection="row" flexGrow={1} minHeight={0}>
  <box flexGrow={1} minHeight={0} />
  <Show when={layout().mode === "dock" && layout().handleVisible}>
    <SidebarResizeHandle ... />
  </Show>
  <Show when={layout().mode !== "hidden"}>
    <Sidebar width={layout().effectiveWidth} overlay={layout().mode === "overlay"} ... />
  </Show>
</box>
```

Use terminal width `120` and requested width `42` to assert dock mode, main width `73`, handle presence, and sidebar width `42`. Use terminal width `118` to assert overlay mode, main width `114`, and no main-pane width reduction from the overlay rail. Use `visible=false` to assert no handle and no rail.

- [ ] **Step 2: Replace the fixed width signal and content-width calculation in `Session`.**

Keep the existing global sidebar visibility preference and `sidebarOpen` behavior. Add the controller after terminal dimensions and KV are available:

```tsx
const sidebarLayout = createSidebarLayoutState({
  terminalWidth: () => dimensions().width,
  visible: sidebarVisible,
  storedWidth: () => kv.get("sidebar_width", DEFAULT_SIDEBAR_WIDTH),
  ready: () => kv.ready,
  persist: (width) => kv.set("sidebar_width", width),
})

const contentWidth = createMemo(() => sidebarLayout.layout().mainContentWidth)
```

Do not keep a second `42` subtraction. The only source of rail width must be `sidebarLayout.layout().effectiveWidth`.

- [ ] **Step 3: Replace the docked render branch.**

The wide branch must render the main content, one handle, and the sidebar in that order:

```tsx
<Show when={sidebarVisible() && sidebarLayout.layout().mode === "dock"}>
  <SidebarResizeHandle
    color={theme.border}
    activeColor={theme.borderActive}
    onStart={(event) => sidebarLayout.beginResize(event.x)}
    onDrag={(event) => sidebarLayout.updateResize(event.x)}
    onEnd={() => sidebarLayout.endResize()}
  />
  <Sidebar sessionID={route.sessionID} width={sidebarLayout.layout().effectiveWidth} />
</Show>
```

The main message pane continues to render exactly as before, including its scrollbox, prompt, Toast, permissions, questions, and subagent footer.

- [ ] **Step 4: Replace the narrow overlay branch.**

Keep the existing dimmed absolute overlay root, but place the handle and Sidebar in a right-aligned row and pass the effective width/overlay flag:

```tsx
<Show when={sidebarVisible() && sidebarLayout.layout().mode === "overlay"}>
  <box
    position="absolute"
    top={0}
    left={0}
    right={0}
    bottom={0}
    alignItems="flex-end"
    backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
  >
    <box flexDirection="row" height="100%">
      <Show when={sidebarLayout.layout().handleVisible}>
        <SidebarResizeHandle
          color={theme.border}
          activeColor={theme.borderActive}
          onStart={(event) => sidebarLayout.beginResize(event.x)}
          onDrag={(event) => sidebarLayout.updateResize(event.x)}
          onEnd={() => sidebarLayout.endResize()}
        />
      </Show>
      <Sidebar
        sessionID={route.sessionID}
        width={sidebarLayout.layout().effectiveWidth}
        overlay
      />
    </box>
  </box>
</Show>
```

If the existing `Sidebar` overlay positioning conflicts with the wrapper row, keep the wrapper as the sole positioning owner and pass `overlay` only where it is required by the existing component API; do not create two independent absolute-positioned parents.

- [ ] **Step 5: Preserve existing visibility semantics.**

Do not replace the existing `sidebarVisible` preference logic with a new always-visible rule. The rail remains automatically docked on the existing wide-terminal path and becomes overlay when the user opens it on a narrow terminal. The `session.sidebar.toggle` command must continue to switch the same `sidebar`/`sidebarOpen` state.

- [ ] **Step 6: Run focused composition tests and typecheck.**

Run:

```bash
bun test test/cli/tui/sidebar.test.tsx
bun test test/routes/session/sidebar-layout-state.test.ts
bun test test/util/sidebar-layout.test.ts
bun typecheck
```

Expected: all focused tests pass and no Session or Sidebar type errors remain.

---

## Task 6: Add keyboard and command-palette controls

**Files:**

- Modify: `packages/tui/src/config/keybind.ts:45-160, 256-320`
- Modify: `packages/tui/src/routes/session/index.tsx:667-735`
- Modify: `packages/tui/test/keymap.test.tsx`
- Test: `packages/tui/test/cli/tui/sidebar.test.tsx`

**Interfaces:**

Add these command names:

```text
session.sidebar.width.decrease
session.sidebar.width.increase
session.sidebar.width.reset
```

Add these keybind definition names:

```text
sidebar_width_decrease
sidebar_width_increase
sidebar_width_reset
```

- [ ] **Step 1: Add failing keymap tests.**

Extend `packages/tui/test/keymap.test.tsx` with a binding lookup test that asserts:

```ts
expect(TuiKeybind.defaultValue("sidebar_width_decrease")).toBe("<leader>[")
expect(TuiKeybind.defaultValue("sidebar_width_increase")).toBe("<leader>]")
expect(TuiKeybind.defaultValue("sidebar_width_reset")).toBe("<leader>0")
```

Also assert the generated command bindings contain one sequence for each command and that the descriptions are `Narrow sidebar`, `Widen sidebar`, and `Reset sidebar width`.

- [ ] **Step 2: Add the definitions and command map entries.**

Place the definitions near `sidebar_toggle`:

```ts
sidebar_width_decrease: keybind("<leader>[", "Narrow sidebar"),
sidebar_width_increase: keybind("<leader>]", "Widen sidebar"),
sidebar_width_reset: keybind("<leader>0", "Reset sidebar width"),
```

Add matching `CommandMap` entries:

```ts
sidebar_width_decrease: "session.sidebar.width.decrease",
sidebar_width_increase: "session.sidebar.width.increase",
sidebar_width_reset: "session.sidebar.width.reset",
```

Do not alter the existing `session.sidebar.toggle` default or the `<leader>1`–`<leader>9` quick-session bindings.

- [ ] **Step 3: Register command-palette commands in Session.**

Add three command entries beside the existing sidebar toggle. Each command must call the controller, then clear the dialog:

```tsx
{
  title: "Narrow sidebar",
  value: "session.sidebar.width.decrease",
  category: "Session",
  run: () => {
    sidebarLayout.decreaseWidth()
    dialog.clear()
  },
},
{
  title: "Widen sidebar",
  value: "session.sidebar.width.increase",
  category: "Session",
  run: () => {
    sidebarLayout.increaseWidth()
    dialog.clear()
  },
},
{
  title: "Reset sidebar width",
  value: "session.sidebar.width.reset",
  category: "Session",
  run: () => {
    sidebarLayout.resetWidth()
    dialog.clear()
  },
},
```

- [ ] **Step 4: Run keymap and command tests.**

Run:

```bash
bun test test/keymap.test.tsx
bun test test/cli/tui/sidebar.test.tsx
bun typecheck
```

Expected: all three bindings compile, command-palette entries are discoverable, and each command changes/persists width through the same state-controller path as dragging.

---

## Task 7: Add complete regression coverage and perform manual TUI verification

**Files:**

- Modify: `packages/tui/test/cli/tui/sidebar.test.tsx`
- Modify: `packages/tui/test/routes/session/sidebar-layout-state.test.ts`
- Modify: `packages/tui/test/util/sidebar-layout.test.ts`

- [ ] **Step 1: Add invalid-state and terminal-resize regressions.**

Cover these exact sequences:

```ts
setStoredWidth(Number.NaN)
setReady(true)
expect(state.requestedWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)

state.beginResize(100)
state.updateResize(90)
setTerminalWidth(80)
expect(state.requestedWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)
expect(state.layout().mode).toBe("overlay")
state.cancelResize()
expect(state.requestedWidth()).toBe(DEFAULT_SIDEBAR_WIDTH)
expect(persisted).toEqual([])

setTerminalWidth(160)
expect(state.layout().mode).toBe("dock")
expect(state.layout().effectiveWidth).toBe(DEFAULT_SIDEBAR_WIDTH)
```

- [ ] **Step 2: Add rail scrollbar independence coverage.**

In the OpenTUI harness, render the actual `Sidebar` with enough plugin content to create overflow. Locate its `ScrollBoxRenderable` and assert that its vertical scrollbar options remain enabled/configured even when the main session scrollbar preference is false. Do not alter `Sidebar` to read the main `showScrollbar` signal.

- [ ] **Step 3: Add interaction safety coverage.**

Assert that:

- a handle drag produces no prompt text or message selection;
- `onEnd` fires at most once when both `onMouseUp` and `onMouseDragEnd` are emitted;
- `cancelResize` leaves no draft width;
- a hidden sidebar renders no handle;
- child/overlay composition does not render a detached handle;
- repeated keyboard commands clamp at `28` and `64`.

- [ ] **Step 4: Run all changed TUI tests and typecheck.**

Run from `packages/tui`:

```bash
bun test test/util/sidebar-layout.test.ts test/routes/session/sidebar-layout-state.test.ts test/cli/tui/sidebar.test.tsx test/keymap.test.tsx
bun typecheck
```

Expected: all changed-feature tests pass and typecheck exits `0`.

- [ ] **Step 5: Run the full TUI package test suite.**

Run:

```bash
bun test
```

Expected: the package suite completes without failures caused by the sidebar rail. If unrelated pre-existing failures occur, record their exact test names and output; do not delete, weaken, or modify those tests.

- [ ] **Step 6: Perform manual terminal verification in tmux.**

From the repository's `packages/opencode` directory, start the live TUI in a disposable tmux session as required by `packages/opencode/AGENTS.md`:

```bash
tmux new-session -d -s opencode-sidebar 'bun dev'
tmux capture-pane -pt opencode-sidebar
```

Exercise terminal widths `80`, `100`, `120`, and `160`; drag the handle left and right; use narrow/widen/reset commands; scroll long sidebar content; switch sessions; focus the prompt; and toggle the main scrollbar. Confirm that the prompt remains editable, the message area does not overlap the docked rail, the narrow rail overlays without shrinking the main pane, and the rail scrollbar remains independent.

Clean up explicitly:

```bash
tmux kill-session -t opencode-sidebar
```

Do not run provider-backed evaluation or alter unrelated runtime WIP for this UI feature.

---

## Verification Checklist

Before reporting the feature complete, verify all of the following with fresh command output:

- `packages/tui/test/util/sidebar-layout.test.ts` passes.
- `packages/tui/test/routes/session/sidebar-layout-state.test.ts` passes.
- `packages/tui/test/cli/tui/sidebar.test.tsx` passes.
- `packages/tui/test/keymap.test.tsx` passes.
- `bun typecheck` from `packages/tui` passes.
- Full TUI tests either pass or have unrelated failures recorded exactly.
- Manual tmux verification covers all four terminal widths and both mouse/keyboard paths.
- `git diff --check` reports no whitespace errors for the feature files.
- `git status --short` confirms no unrelated files were modified by the implementation.
- No commit is created unless the user explicitly requests one.

## Spec Coverage Self-Review

The plan covers the design spec as follows:

- Right rail meaning and separation from scrollbar: Tasks 3–5.
- Default/range `42`/`28`–`64`: Tasks 1–2 and Task 6.
- Requested versus effective width: Tasks 1–2 and Task 7.
- Dock/overlay behavior and minimum main width `72`: Tasks 1 and 5.
- Existing four-column main padding and one-column handle: Tasks 1 and 5.
- Native independent rail scrollbar: Task 4 and Task 7.
- Global KV persistence: Tasks 2 and 5.
- Exactly one write on successful drag completion: Tasks 2 and 7.
- Cancelled drag behavior: Tasks 2 and 7.
- Keyboard and command-palette fallback: Task 6.
- Invalid persisted state: Tasks 1, 2, and 7.
- Mouse propagation/focus safety: Task 3 and Task 7.
- Session/plugin/prompt behavior preservation: Tasks 4, 5, and 7.
- Typecheck, focused tests, full tests, and manual verification: every task's test step and Task 7.

No implementation step requires a generated SDK, server change, database migration, provider call, or unrelated WIP modification.

## Plan Self-Review

- Placeholder scan: no `TBD`, `TODO`, `FIXME`, or unspecified implementation steps are required.
- Type consistency: Task 1 defines `SidebarLayout`; Task 2 consumes it and exports `SidebarLayoutState`; Tasks 3–6 consume those exact names and props.
- Boundary consistency: pure arithmetic is isolated from Solid state; mouse rendering is isolated from persistence; Session remains the only layout owner.
- Testability: the absence of an existing Session route fixture is handled by a focused OpenTUI composition harness rather than a duplicate 2700-line route setup.
- Worktree safety: the plan explicitly excludes the unrelated dirty runtime/evaluation files already present in the repository.
