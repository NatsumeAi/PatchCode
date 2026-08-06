# TUI: Default-Collapse Compaction Result (Grok-style Fold)

## Status

Proposed design. This document is ready for review; implementation must not begin until the design is approved.

## Summary

The TUI currently paints a compaction summary as a full user message (its whole text is visible inline), which floods the conversation with a large block of text every time the context is compacted. This change makes the compaction result **collapsed by default**, following the same fold mechanism thinking already uses: the summary is hidden behind the existing centered ` Compaction ` divider bar, and clicking the bar expands/collapses the summary.

The change is a single-file, render-layer modification in `packages/tui/src/routes/session/index.tsx`. No event-projection layer, selection, keyboard bindings, or other modules are touched.

## Problem and Goals

### Problem

Compaction summaries are long. After the session is compacted (auto or manual), the summary text is projected as a user message and rendered in full (`UserMessage`, `index.tsx:1577-1683`). Reading a long session becomes noisy because every compaction dumps a large block of text into the stream. Users cannot fold it away.

### Goals

- Compaction summaries are collapsed by default, so the conversation stays readable.
- The fold interaction mirrors thinking: a click on the divider bar toggles expanded/collapsed.
- The visual style of the divider bar stays as-is (`border top + title " Compaction "`).
- Reuse the existing pin mechanism (`getPin`/`setPin`) so expanded state follows the same session-memory semantics as thinking (§3.8: lost on refresh).
- Do not change any existing logic or module wiring. Non-compaction user messages must render byte-for-byte identically to today.

### Non-goals

- No keyboard fold (`h`/`l`/`e`) for compaction parts; selection remains tool/reasoning only.
- No preview of the summary content in the collapsed bar (no first-line truncation).
- No persistent (kv) preference for compaction expansion.
- No distinction between `auto` and `manual` compaction reasons — both default collapsed.
- No changes to the event-projection layer (`data.tsx`, `sync.tsx`, `v2-message-bridge.ts`).
- No new components, no session-display changes, no new modules.

## Existing Context and Constraints

Relevant current implementation (`packages/tui/src/routes/session/index.tsx`, HEAD `219e0b996a`):

- **Compaction projection** (unchanged, outside scope): three paths — `context/sync.tsx:1386-1417`, `context/v2-message-bridge.ts:315-339`, `context/data.tsx:377-384` — each emit a `UserMessage` whose text part carries the summary, plus a `Part` with `type: "compaction"` (fields: `id`, `sessionID`, `messageID`, `auto`).
- **`UserMessage` rendering** (`index.tsx:1577-1683`):
  - `text()` memo collects non-synthetic text parts (the summary).
  - `compaction()` memo: `props.parts.find((x) => x.type === "compaction")`.
  - Body block: `<Show when={text()}>` renders the summary as a user message (the noise source).
  - Divider: `<Show when={compaction()}>` renders `<box marginTop={1} border={["top"]} title=" Compaction " titleAlignment="center" borderColor={theme.borderActive} />`.
- **Pin store** (`display/pin-store.ts:26/39`): `getPin(partId): DisplayMode | null`, `setPin(partId, mode)`. Already imported in `index.tsx:112-119`. Session memory; fine-grained Solid store (reading `pins[id]` tracks only that id).
- **Thinking fold reference** (`ReasoningPart`, `index.tsx:1904-1964`): `handleClick` does `setPin(props.part.id, vm().mode === "collapsed" ? "expanded" : "collapsed")`; view-model mode comes from `getPin(id) ?? <default>`.
- **Press-release click** (`display/press-release.ts:18`): `createPressReleaseClick(onActivate)` returns `{ onMouseDown, onMouseUp, onMouseOut }`, arming only when press and release land on the same target with `maxDrag = 1`. Already used by `ReasoningEntry`/`ToolEntry`; **not yet imported** in `index.tsx`.
- **Body click** (`index.tsx:1625` + call site `1462-1464`): user-message body `onMouseUp` opens `DialogMessage`, guarded by `getSelectedText()`.
- **Selection** (`index.tsx:260-266`): `selectableEntries` filters `p.type === "tool" || p.type === "reasoning"` — compaction parts are never keyboard-selectable.

## Design

### Approach

Render-layer folding in `UserMessage`. The summary body renders only when the compaction is expanded; the divider bar becomes clickable and toggles the fold. Default (no pin) is collapsed.

### Decisions (confirmed with user)

1. Collapsed bar keeps the current divider style — `border top + " Compaction "` centered, `borderColor` per theme — no content preview.
2. Interaction is mouse-only (no selection/keyboard changes).
3. Expansion state reuses the pin store (`getPin`/`setPin`), identical semantics to thinking.

## Precise Changes

**Only file: `packages/tui/src/routes/session/index.tsx`.** Approx. +15 lines net; one condition change; one import.

### Change A — import (1 line)

After the `pin-store` import block (`index.tsx:112-119`):

```ts
import { createPressReleaseClick } from "../../display/press-release"
```

### Change B — `UserMessage` component (`index.tsx:1577-1683`)

**B1. State (≈6 lines**, placed near the existing `const [hover, setHover] = createSignal(false)`):

```ts
const [barHover, setBarHover] = createSignal(false)

// Compaction messages are collapsed by default; non-compaction messages keep
// their body always visible (isolation guarantee). Expansion follows the same
// §3.8 pin semantics as thinking (session memory, lost on refresh).
const compactionExpanded = createMemo(() => {
  const c = compaction()
  if (!c) return true
  return getPin(c.id) === "expanded"
})

const barPress = createPressReleaseClick(() => {
  const c = compaction()
  if (!c) return
  setPin(c.id, compactionExpanded() ? "collapsed" : "expanded")
})
```

**B2. Body condition (1 line change):**

```tsx
// before: <Show when={text()}>
<Show when={text() && compactionExpanded()}>
```

**B3. Divider block (`index.tsx:1672-1680`, ≈6 line change):**

```tsx
<Show when={compaction()}>
  <box
    marginTop={1}
    border={["top"]}
    title=" Compaction "
    titleAlignment="center"
    borderColor={barHover() ? theme.text : theme.borderActive}
    onMouseOver={() => setBarHover(true)}
    onMouseOut={() => {
      setBarHover(false)
      barPress.onMouseOut?.()
    }}
    onMouseDown={barPress.onMouseDown}
    onMouseUp={barPress.onMouseUp}
  />
</Show>
```

## Safety Analysis

| # | Claim | Evidence |
|---|---|---|
| S1 | Non-compaction user messages render byte-for-byte identically | `compaction()` is `undefined` → `compactionExpanded()` is `true` → body condition `text() && true` ≡ current `text()`; divider `Show` is false; `barHover`/`barPress` never fire (their handlers only mount on the divider box). |
| S2 | Event-projection layer untouched | `data.tsx`, `sync.tsx`, `v2-message-bridge.ts` have zero diff; `rehydrateAfterCompaction` unchanged. |
| S3 | Selection/keyboard untouched | `selectableEntries` filter (`index.tsx:260-266`) unchanged; `foldSelected`/`toggleExpandAll`/`applyToAll` never see compaction parts. |
| S4 | Pin store has no collisions | Reuses already-imported `getPin`/`setPin`; keys are compaction part ids (`prt_${messageID}_compaction`), disjoint from tool/reasoning part ids. |
| S5 | Body click (DialogMessage) does not conflict | Body `onMouseUp` stays on the body box; the divider is a separate box with its own press-release handlers; `createPressReleaseClick` guards drag (maxDrag=1, `press-release.ts:16-44`). |
| S6 | Default behavior matches the request | No pin → collapsed → divider only; click → `setPin("expanded")` → full summary shown. |
| S7 | No global side effects | No kv, no localStorage, no new modules, no effects; purely component-local state plus the existing pin store. |

## Edge Cases

- Folded body hides the inline `queued()`/timestamp metadata (it lives inside the body block) — expected.
- Expanded state is lost on refresh (pin is session memory) — back to collapsed; same semantics as thinking.
- Re-collapsing after expand writes `setPin("collapsed")` — explicit, deterministic.
- Compaction messages carry no file parts, so `files()` is empty; the shared `compactionExpanded()` guard covers it regardless.
- `auto` vs `manual` compaction both default collapsed (no reason-based branching).

## Testing Plan

| Verification | Command | Expected |
|---|---|---|
| Typecheck | `cd packages/tui && bun typecheck` | exit 0 |
| Regression (individually) | `cd packages/tui && bun test` | baseline green (cli 64 + display 44) |

Notes:

- `routes/session/index.tsx` has no existing component-test harness (only `sidebar-layout-state.test.ts` exists under `test/routes/session/`). The fold decision is a 3-line inline boolean; extracting a pure helper would violate AGENTS.md ("Do not extract single-use helpers preemptively").
- `createPressReleaseClick` already has coverage (`test/display/press-release.test.ts`).
- Known pre-existing F7: running all TUI tests in one invocation produces 3 failures from test isolation; individual runs are green and are the baseline.

## Acceptance Criteria

1. After any compaction (auto or manual), the summary is shown collapsed: only the ` Compaction ` divider bar renders, no body text.
2. Clicking the divider bar expands the full summary; clicking again collapses it.
3. Non-compaction user messages render exactly as before.
4. Hovering the divider gives a subtle affordance (borderColor highlight).
5. `bun typecheck` in `packages/tui` passes; the individual TUI test baseline stays green.
