# TUI Right Sidebar Rail and Resize Handle

## Status

Proposed design. This document is ready for user review; implementation must not begin until the design is approved.

## Summary

Add a mature, terminal-native right-side rail to the OpenCode TUI. The rail is a session sidebar that can be shown or hidden, resized with a draggable vertical handle, and scrolled independently from the main conversation. On wide terminals it is docked beside the conversation; on narrow terminals it becomes the existing right-aligned overlay behavior so the prompt and message area remain usable.

The feature deliberately separates two interactions that are often confused:

1. **Resize handle:** changes the width of the right rail.
2. **Scrollbar:** moves through overflow content inside the right rail.

The implementation reuses the existing `Sidebar`, `scrollbox`, `session.sidebar.toggle`, `useKV`, theme, and OpenTUI mouse-event patterns. It must not introduce a second layout system or change session/message business behavior.

## Problem and Goals

The current TUI has a fixed-width sidebar (`42` columns) and an existing sidebar toggle, but users cannot adapt the sidebar to the amount of content it contains. A narrow sidebar truncates useful information; a wide sidebar wastes conversation space. The current sidebar already has an independent scrollbox, but the layout boundary is not interactive and the width is not user-configurable.

### Goals

- Allow users to resize the docked right sidebar with the mouse.
- Keep the sidebar content independently scrollable through OpenTUI's native `scrollbox`.
- Preserve the existing sidebar toggle command and behavior.
- Persist the user's preferred width across TUI restarts.
- Preserve the preferred width when the terminal temporarily becomes too narrow.
- Provide keyboard and command-palette alternatives when mouse capture is disabled or unavailable.
- Automatically use overlay mode when docking would make the main conversation unusable.
- Keep the feature session-safe: changing the rail must not change session data, message scroll state, prompt contents, or execution behavior.
- Make width calculation and mode selection pure and unit-testable.

### Non-goals

- This is not a model, temperature, context, or execution-parameter slider.
- This does not replace or change the main conversation scrollbar.
- This does not add a second sidebar content model or new plugin slots.
- This does not introduce animated layout transitions in the first implementation.
- This does not persist a separate width for every session.
- This does not redesign the existing sidebar content, footer, or plugin API.

## Existing Context and Constraints

The relevant current implementation is in `packages/tui`:

- `packages/tui/src/routes/session/index.tsx`
  - Owns the session layout, terminal dimensions, sidebar visibility, command registrations, main message scrollbox, and content width calculation.
  - The current docked width is subtracted as a fixed `42` columns.
  - Narrow terminals already render the sidebar as an absolute right-aligned overlay with a dimmed background.
- `packages/tui/src/routes/session/sidebar.tsx`
  - Owns the sidebar shell, title/content plugin slots, footer, and sidebar `scrollbox`.
  - The current shell has a hard-coded width of `42`.
- `packages/tui/src/context/kv.tsx`
  - Provides persisted TUI state backed by an atomic JSON file and queued writes.
- `packages/tui/src/config/keybind.ts`
  - Defines configurable TUI bindings and command names.
- `packages/tui/src/util/scroll.ts`
  - Provides the existing scroll acceleration configuration used by scrollboxes.
- `packages/tui/src/theme/index.ts`
  - Provides the colors for normal, muted, active, border, and selected states.

The reference corpus at `/home/huyongjun/reference/` contains a mature OpenCode TUI implementation with the same important patterns:

- fixed or computed sidebar width;
- `scrollbox` with `verticalScrollbarOptions`;
- session-wide KV preferences;
- command-driven sidebar toggling;
- mouse handlers on renderables for interactive controls;
- wide-terminal dock mode and narrow-terminal overlay mode.

OpenTUI renderables support `onMouseDown`, `onMouseDrag`, `onMouseDragEnd`, `onMouseUp`, hover events, and propagation control. Mouse events bubble through the renderable tree, so the resize handle must stop propagation while it owns a drag.

## User Experience

### Wide-terminal layout

```text
┌──────────────────────────────────────────────┬─┬──────────────┐
│                                              │⋮│              │
│              Main conversation               │⋮│  Right rail  │
│                                              │⋮│  scrollbox   │
│                                              │⋮│              │
└──────────────────────────────────────────────┴─┴──────────────┘
```

The handle is placed immediately to the left of the rail. The rail remains on the right side. Dragging the handle left increases the rail width; dragging it right decreases the rail width.

### Narrow-terminal layout

```text
┌──────────────────────────────────────────────┐
│              Main conversation          ┌─┬───┤
│                                        │⋮│rail│
│                                        │⋮│    │
└────────────────────────────────────────┴─┴───┘
```

The main content keeps its full available width. The rail overlays the right edge, using the existing dimmed-background behavior. The resize handle remains on the rail's left edge.

### Visual states

The handle is one terminal column wide visually. Its normal color is the regular border color. On hover or during drag it uses the active border or primary color from the current theme. The handle should not use a large decorative glyph or animation; a stable one-column boundary is easier to see in low-color terminals and does not disturb the surrounding layout.

If the OpenTUI hit target is too narrow for reliable mouse use, the implementation may give the handle a two-column hitbox while drawing only one visible boundary column. The hitbox must not reduce the effective content width twice.

## Width and Layout Model

### Constants

The first implementation uses these defaults:

```text
default sidebar width: 42 columns
minimum sidebar width: 28 columns
maximum sidebar width: 64 columns
resize handle width: 1 layout column
minimum main content width: 72 columns
```

These values are product constants, not scattered literals. They belong in the layout module so tests and future configuration changes have one source of truth.

### Requested versus effective width

Maintain two concepts:

- `requestedWidth`: the user's preferred width, persisted in TUI KV.
- `effectiveWidth`: the width that can fit in the current terminal and layout mode.

The effective width is derived without overwriting the requested width. The docked formula is evaluated only when docking is possible, so its upper bound is always at least the minimum width:

```text
effectiveDockedWidth = clamp(
  requestedWidth,
  minimumWidth,
  min(maximumWidth, terminalWidth - minimumMainWidth - handleWidth - existingPadding),
)
```

If the terminal becomes too narrow to satisfy the normal dock constraints, the layout changes to overlay mode. In overlay mode, the main content width does not subtract the rail or handle. The rail uses the largest width that fits, with a lower bound of one column rather than the normal dock minimum:

```text
effectiveOverlayWidth = clamp(
  requestedWidth,
  1,
  min(maximumWidth, terminalWidth - overlayPadding),
)
```

If `terminalWidth - overlayPadding` is zero or negative, render no rail and no resize handle. The requested width remains unchanged so it can be restored when the terminal grows.

When the terminal grows again, docking resumes and the last `requestedWidth` is restored. A temporary terminal resize must not permanently replace the user's preference with a smaller fallback width.

### Docking decision

The docking decision is a pure function based on terminal width, minimum main width, handle width, padding, and the requested rail width. It should preserve the current behavior's approximate wide-terminal threshold rather than hard-coding `120` into multiple callers.

The rule is:

```text
canDock = terminalWidth >= minimumMainWidth + requestedWidth + handleWidth + existingPadding
```

If `canDock` is false, use overlay mode. For the current `Session` layout, `existingHorizontalPadding` is four columns: two columns of left padding and two columns of right padding on the main pane. This value must be represented once in the layout calculation; callers must not independently subtract padding.

### Main content width

In dock mode:

```text
mainContentWidth = terminalWidth - effectiveSidebarWidth - handleWidth - existingHorizontalPadding
```

In overlay mode:

```text
mainContentWidth = terminalWidth - existingHorizontalPadding
```

This value continues to feed the existing session context so message rendering and wrapping use the available main area. No message component should need to know whether the sidebar is docked or overlayed.

## Component Boundaries

### `packages/tui/src/util/sidebar-layout.ts`

Add a small pure-function module for layout math. It should export only concepts used by the session route and tests, for example:

- width constants;
- `clampSidebarWidth(value, bounds)`;
- `maxDockedSidebarWidth(terminalWidth, constraints)`;
- `resolveSidebarMode(input)`;
- `resolveSidebarLayout(input)`;
- `widthFromDrag(input)`.

The module must normalize invalid persisted input. `NaN`, infinities, negative values, non-finite values, and values outside the legal range must resolve to the default or the appropriate clamp result. It must not throw during render.

Do not put Solid signals, KV access, or mouse events in this module.

### `packages/tui/src/routes/session/sidebar-resize-handle.tsx`

Add a focused presentational/interaction component. Its responsibilities are:

- render the one-column separator;
- expose hover and dragging visual states;
- call `onStart`, `onDrag`, and `onEnd` callbacks supplied by the parent;
- stop mouse propagation while dragging;
- avoid owning persistence or terminal-width policy.

The component should accept the current theme colors and callbacks rather than reaching into session state. This keeps it usable in isolated TUI tests.

### Session layout controller in `packages/tui/src/routes/session/index.tsx` or a focused sibling module

The session route remains the owner of route-local layout state because it already owns:

- `useTerminalDimensions()`;
- `useKV()`;
- sidebar visibility and overlay behavior;
- command registration;
- the layout tree.

If the controller logic makes `index.tsx` materially harder to read, place the stateful logic in a focused sibling module such as `sidebar-layout-state.ts`. Do not create a general-purpose layout store for the whole TUI for this feature.

The controller exposes:

- `requestedWidth()`;
- `draftWidth()` or an equivalent idle/dragging state;
- `effectiveWidth()`;
- `mode()`;
- `docked()`;
- `beginResize(startX)`;
- `updateResize(currentX)`;
- `endResize()`;
- `increaseWidth()`;
- `decreaseWidth()`;
- `resetWidth()`.

### `packages/tui/src/routes/session/sidebar.tsx`

Change the current fixed width to a required `width` prop. Keep all current sidebar content and slots intact. Continue to use the native `scrollbox` and its scrollbar options. The sidebar component should not calculate the main conversation width or know whether it is docked; its shell only needs the effective width and the existing `overlay` flag.

## State and Data Flow

### Initialization

1. Read `sidebar_width` from `useKV()`.
2. Normalize it through the pure layout function.
3. Store it as committed `requestedWidth` in a Solid signal or KV-backed signal.
4. Keep `draftWidth` unset while idle.
5. Derive `mode`, effective width, and `mainContentWidth` from terminal dimensions, visibility, and `draftWidth ?? requestedWidth`.
6. Render the main pane, optional handle, and sidebar using those derived values.

The persisted value is global TUI state, not session state. The same width should apply when the user changes sessions.

### Resize drag

On mouse down:

1. Stop propagation.
2. Record `startX` and `startWidth`.
3. Set `draftWidth` to the committed `requestedWidth` and enter `dragging` state.

On mouse drag:

1. Stop propagation.
2. Compute `deltaX = currentX - startX`.
3. Compute `candidateWidth = startWidth - deltaX`.
4. Clamp the candidate to the normal requested-width range (`minimumWidth`–`maximumWidth`).
5. Update only the in-memory `draftWidth`; the displayed width is derived from that draft and the current terminal constraints.

On mouse drag end or mouse up:

1. Stop propagation.
2. Leave `dragging` state.
3. Promote the final normalized `draftWidth` to `requestedWidth`.
4. Persist the final normalized width once through `useKV().set`.

If the drag is cancelled by a route change, unmount, or terminal teardown, discard `draftWidth`, restore the committed `requestedWidth`, return to the idle state, and do not write KV for the cancelled drag. This makes persistence deterministic and prevents a lost mouse-up event from committing a partial resize.

### Keyboard and command flow

The command handlers call the same width controller methods as mouse drag. There must be exactly one width mutation path so keyboard and mouse cannot diverge in clamping or persistence behavior.

## Commands and Keybindings

Keep the existing command:

```text
session.sidebar.toggle
```

Add these configurable commands:

```text
session.sidebar.width.decrease
session.sidebar.width.increase
session.sidebar.width.reset
```

Suggested defaults:

```text
<leader>[   Narrow sidebar
<leader>]   Widen sidebar
<leader>0   Reset sidebar width
```

The bracket bindings follow the repository's existing literal `[` and `]` key syntax, and `<leader>0` is chosen as an unambiguous reset binding that does not overlap the existing `<leader>1`–`<leader>9` quick-session bindings.

Each command must be available through the command palette even if its default key is disabled. The command title should communicate the effect and current context, for example `Widen sidebar` rather than `Adjust layout`.

Width adjustment uses a two-column step. The reset command restores the default width, not the minimum width. Commands should close any open command dialog consistently with the existing sidebar toggle handler.

The main message navigation bindings must not be repurposed. Arrow keys remain owned by the prompt or existing session navigation layers; width controls are leader commands to avoid focus conflicts.

## Scrolling Behavior

The right rail continues to use its current `scrollbox`:

- preserve `scrollAcceleration` from TUI configuration;
- preserve the current footer outside the scrollbox;
- preserve plugin slots and their ordering;
- configure the rail scrollbar independently from the main session scrollbar;
- do not let `session.toggle.scrollbar` hide the rail scrollbar.

The main message `scrollbox` retains its existing `showScrollbar` behavior and keybindings. The rail's scrollbar is a structural navigation aid for the rail and is not part of the message display preference.

No custom scrollbar drawing is needed in the first implementation. OpenTUI's `verticalScrollbarOptions` already provides the native track and thumb behavior and is more reliable than duplicating scroll geometry in application code.

## Accessibility and Input Robustness

Terminal accessibility is primarily about discoverability, stable semantics, and non-mouse alternatives:

- The resize handle must have a stable border appearance and a distinct active color.
- The command palette must expose all resize actions with clear names.
- The width commands must work when mouse capture is disabled.
- Width changes should not require focus to move away from the prompt.
- The rail should remain keyboard-scrollable through existing scrollbox behavior and session navigation where applicable.
- The implementation must not rely on color alone for correctness; the current width is observable through the rail's geometry and command names.
- The resize handle must not steal text input focus or insert characters into the prompt.
- Mouse events owned by the handle must stop propagation so a drag cannot select or activate message content.

If the terminal does not report usable mouse drag events, the feature still remains fully usable through the three commands. The application should not show an error merely because mouse capture is unavailable.

## Failure and Boundary Behavior

### Invalid persisted width

Treat invalid values as untrusted configuration. Normalize to the default width, keep rendering, and allow the next successful resize or state write to replace the invalid value. Do not crash the TUI because `kv.json` contains an old or malformed value.

### Very narrow terminal

Use overlay mode rather than allowing the main pane to collapse below its minimum. If the terminal is narrower than the rail's minimum width, clamp the overlay rail to the largest width that fits, while preserving the requested width for later restoration. If even a one-column rail cannot be meaningfully rendered, hide the resize affordance and keep the existing sidebar toggle behavior rather than producing negative or overflowing layout values.

### Terminal resize during drag

Recompute legal bounds from the latest terminal dimensions on every drag update. The candidate must always be clamped. If the mode changes from dock to overlay during a drag, finish the drag using the rail's current visual boundary and persist the final legal requested width once.

### Missing session data

Preserve the current `Show when={session()}` behavior. The handle must not render as a detached separator when the sidebar has no session data.

### Route/session change

End any active drag on cleanup. Do not leak event handlers or retain a resize session into a different route. The persisted width is global and should not be reset when the session changes.

### Persistence failure

Use the existing KV write queue and error handling. A failed write must not roll back the in-memory width or break the active TUI. The user can continue using the current layout; a later write may retry according to the existing KV behavior.

## Testing Strategy

### Pure layout tests

Add focused tests for the layout utility covering:

- default width;
- minimum and maximum clamps;
- invalid values including `NaN`, infinities, negative numbers, strings, and missing values;
- docking at the exact threshold;
- overlay below the threshold;
- main content width in dock mode;
- main content width in overlay mode;
- restoration of the requested width after a temporary terminal shrink;
- dragging left increases width;
- dragging right decreases width;
- drag results clamp at both bounds;
- keyboard step and reset calculations.

### Component and route tests

Add or extend TUI tests to verify:

1. the default docked sidebar remains `42` columns;
2. the existing sidebar toggle still changes visibility;
3. dock mode subtracts the rail and handle from the main area;
4. overlay mode does not subtract the rail from the main area;
5. mouse down begins a resize without changing width until a drag update;
6. mouse drag updates the visible width;
7. mouse up/drag end persists only the final width;
8. resize events do not bubble into message or prompt handlers;
9. narrow, widen, and reset commands use the same clamp logic;
10. a terminal resize preserves the requested width across dock/overlay transitions;
11. the rail scrollbox keeps its own scrollbar behavior;
12. the main scrollbar toggle does not disable the rail scrollbar;
13. an invalid KV width falls back without throwing;
14. cleanup ends an active drag;
15. child sessions and overlay sessions do not render a stray handle.

Prefer real component behavior over duplicated layout logic in tests. Avoid global mocks unless the TUI harness requires them.

### Manual verification matrix

Before considering the feature complete, manually exercise:

```text
terminal widths: 80, 100, 120, 160
rail widths: minimum, default, maximum
sidebar contents: empty, long plugin list, long file list, multiple sections
input modes: mouse enabled, mouse disabled, prompt focused
themes: normal theme and a high-contrast/active-border theme
routes: parent session, child session, docked session, overlay session
actions: toggle, drag left, drag right, reset, terminal resize, session switch
```

The TUI should remain responsive while dragging, the prompt should remain editable, and no message content should be selected or activated as a side effect of resizing.

## Implementation Sequence

1. Add the pure layout model and tests.
2. Replace fixed `42` width and fixed content-width subtraction with derived layout values.
3. Add the focused resize handle and connect it to the shared controller.
4. Add KV persistence for `sidebar_width` with one write on drag completion.
5. Add keyboard/command-palette bindings.
6. Add route/component regression coverage.
7. Run package diagnostics, focused TUI tests, package typecheck, and manual TUI verification.

Each step should be independently type-safe and should not change unrelated session behavior.

## Acceptance Criteria

The design is successfully implemented when all of the following are true:

- The right rail defaults to 42 columns for users with no saved preference.
- Users can resize it with a mouse drag on the vertical handle.
- Dragging left makes the rail wider and dragging right makes it narrower.
- Width is clamped to 28–64 columns when docking constraints allow it.
- The requested width survives TUI restart and temporary terminal resizing.
- The rail's content scrolls independently through the native scrollbox scrollbar.
- The main conversation scrollbar setting remains independent.
- Wide terminals dock the rail; narrow terminals use the existing overlay pattern.
- The prompt, message scrolling, session switching, and plugin slots keep their current behavior.
- Keyboard and command-palette commands provide complete non-mouse control.
- Invalid saved state, missing session data, persistence errors, and interrupted drags do not crash or corrupt the TUI.
- Focused tests, diagnostics, and typecheck pass for the changed TUI code.

## Open Decisions Resolved by This Spec

- **Meaning of slider:** a draggable layout boundary, not a business-parameter control.
- **Rail placement:** right side of the CLI.
- **Scroll behavior:** native independent rail scrollbar.
- **Persistence scope:** global TUI preference, not per session.
- **Default/range:** 42 default, 28 minimum, 64 maximum.
- **Small terminals:** overlay rather than collapsing the main pane.
- **Mouse fallback:** command palette and configurable leader commands.

## Review Notes

- This document intentionally does not commit to implementation-specific helper names beyond the suggested boundaries; the implementation plan may consolidate a state module if the resulting API remains equivalent.
- The exact OpenTUI mouse event payload fields must be confirmed against the installed version when implementation begins. The interaction contract is fixed, but the low-level event field names are not part of this design document.
- No code changes are included in this design step.
