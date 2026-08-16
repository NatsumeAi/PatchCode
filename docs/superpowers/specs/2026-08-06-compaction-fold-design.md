# TUI: Default-Collapse Compaction Result (Grok-style Fold)

## Status

Proposed design. This document is ready for review; implementation must not begin until the design is approved.

## Summary

The TUI currently paints a compaction summary as a full user message, which floods the conversation with a large block of text whenever the context is compacted. This change makes the summary collapsed by default, following the user-facing fold behavior of thinking: the existing centered ` Compaction ` divider remains visible and clicking it expands or collapses the summary.

The implementation remains TUI-only, but it must preserve three existing behaviors that the first draft did not specify sufficiently:

1. A folded compaction message must retain a stable `message.id` scroll/timeline anchor.
2. The existing message-action path (Copy, Revert, Fork) must not be silently lost.
3. Compaction folding must not use the global verb-group invalidation path for unrelated assistant messages.

The proposed implementation is therefore a small TUI render-layer feature with a dedicated compaction entry/anchor and an explicit component-level state boundary. It must not modify event projection, message storage, session execution, or keyboard selection.

## Problem and Goals

### Problem

Compaction summaries are long. After compaction, the summary text is projected as a user-message text part and rendered in full by `UserMessage` (`packages/tui/src/routes/session/index.tsx:1577-1683`). Long sessions become noisy because each compaction inserts a large block of summary text into the transcript.

### Goals

- Compaction summaries are collapsed by default so long summaries do not disturb the conversation.
- Clicking the existing centered ` Compaction ` divider toggles the summary body.
- The divider keeps its current visual style; the collapsed state has no summary preview.
- A folded compaction keeps a stable renderable anchor with `id={message.id}` so message navigation, timeline jumps, and last-user-message navigation continue to work.
- Existing message actions remain available through an explicitly defined path in both collapsed and expanded states.
- Non-compaction user messages retain their existing visible behavior and interaction behavior.
- Folding state is local to the rendered compaction entry and does not trigger unrelated assistant verb-group recomputation.
- Event projection, durable data, session execution, selection, and keyboard bindings remain unchanged.

### Non-goals

- No keyboard fold (`h`/`l`/`e`) for compaction parts; selection remains tool/reasoning only.
- No summary preview in the collapsed divider.
- No persistent KV preference for compaction expansion.
- No distinction between `auto` and `manual` compaction reasons; both default collapsed.
- No changes to `packages/tui/src/context/data.tsx`, `packages/tui/src/context/sync.tsx`, or `packages/tui/src/context/session-message-bridge.ts`.
- No changes to session-display kernel code, SDK schemas, message storage, or execution logic.
- No change to the existing navigation commands or their message filtering rules.

## Existing Context and Constraints

Relevant current implementation at review baseline `f9b76bd7c8`:

- **Current Session route data path:** `packages/tui/src/routes/session/index.tsx` renders from `useSync()` (`sync.data.message` and `sync.data.part`). The V2 `useData()` store in `packages/tui/src/context/data.tsx` is a separate event-reducer path and is not itself the `UserMessage` render source.
- **Current compaction projection paths:**
  - `packages/tui/src/context/sync.tsx:1386-1417` handles the live `session.next.compaction.ended` event by adding a legacy-shaped user message, text part, and compaction part, then rehydrates the transcript.
  - `packages/tui/src/context/session-message-bridge.ts:315-339` converts a durable V2 `SessionMessageCompaction` into the legacy-shaped user message, text part, and compaction part during rehydration.
  - `packages/tui/src/context/data.tsx:380-389` independently stores a V2 `SessionMessageCompaction`; it is related context but is not the same `UserMessage + Part` render path.
- **Current `UserMessage` rendering** (`index.tsx:1577-1683`):
  - `text()` collects non-synthetic text parts.
  - `compaction()` finds the `type: "compaction"` part.
  - The text body is rendered in a box with `id={props.message.id}`.
  - The compaction marker is a separate border-only box without an id.
  - The body `onMouseUp` opens `DialogMessage` (`index.tsx:1462-1475`), whose actions are Copy, Revert, and Fork (`dialog-message.tsx:21-105`). The new collapsed header must add a separate action target rather than remove this capability.
- **Current navigation dependencies:**
  - `session.messages_last_user` (`index.tsx:977-1005`) finds a user message with valid text and then looks up a child by `message.id`.
  - `session.message.next` / `session.message.previous` are registered at `index.tsx:1008-1019` and call `scrollToMessage`, whose `findNextVisibleMessage` helper (`index.tsx:495-539`) derives visible message boundaries from direct scrollbox children whose ids match message ids.
  - `DialogTimeline` and `DialogForkFromTimeline` (`dialog-timeline.tsx:22-46`, `dialog-fork-from-timeline.tsx:22-75`) select user messages by id and call the route's scroll-to-message callback.
- **Existing fold components:** `ReasoningEntry` and `ToolEntry` use `createPressReleaseClick` (`packages/tui/src/display/press-release.ts:18-45`) for click-without-drag behavior.
- **Pin store limitation:** `packages/tui/src/display/pin-store.ts:13-14` is a module-level process store keyed only by part id. `setPin` (`:39-43`) also increments the global `groupEpoch`, which `AssistantMessage.runs()` subscribes to (`index.tsx:1721-1723`). This global path is appropriate for tool/reasoning grouping, but must not be used for compaction-only local state.
- **Test harness:** TUI has an OpenTUI component harness (`@opentui/solid` `testRender`), used by `packages/tui/test/display/render-safety.test.tsx` and mouse interaction tests such as `packages/tui/test/cli/tui/sidebar.test.tsx`.
- **Test boundary:** A focused entry test can prove rendering, ids, layout, and mouse-target behavior. It cannot by itself prove the route-owned `messages_last_user`, `next/previous`, timeline, or fork scroll callbacks; those require a route-level fixture/integration assertion or an explicit source-level review that the existing lookup code is unchanged and still sees the stable anchor.

## Design

### Approach

Add a dedicated `CompactionEntry` render boundary in the TUI session route (it may remain in `index.tsx` if that is the smallest safe boundary). The entry owns:

1. a stable outer anchor with `id={message.id}` that is mounted in both folded and expanded states;
2. a local `expanded` signal initialized to `false`;
3. the existing divider-style clickable header;
4. the summary body, mounted only while expanded;
5. an explicit message-actions affordance/path that does not conflict with divider toggling.

The fold target must occupy a real, non-zero layout area. Because the current divider is a border-only empty box, the implementation must give the header/fold target an explicit one-row height (for example, `height={1}`) or an equivalent layout guarantee, and the interaction test must click inside that rendered row.

The key requirement is that the outer anchor is never conditionally removed. The implementation must not use `Show when={text() && expanded()}` around the only element carrying `message.id`.

### Decisions

1. Collapsed state keeps the current centered ` Compaction ` divider style and shows no content preview.
2. Interaction is mouse-only for folding; compaction is not added to keyboard selection.
3. Default state is collapsed for both auto and manual compaction.
4. Folding state is component-local, not stored in the global tool/reasoning pin store. It is transient session-view state and may reset when the route is remounted.
5. The message anchor is always mounted exactly once. Expanded and collapsed states must never create duplicate `message.id` renderable ids.
6. Message actions remain directly reachable through one concrete mechanism: the stable entry adds a small visible `⋯` action target at the right side of the header area. The centered ` Compaction ` divider/title area remains the fold target. The action target opens the existing `DialogMessage` path with its own press-release handling so one click cannot also toggle the fold. In expanded state, the existing summary-body click continues to open the same actions path.

The concrete layout boundary is: one outer anchored box owns the existing top border/title and `alwaysSeparate` registration; its fold target occupies the divider/header area; its separate right-aligned action target is a child renderable with its own mouse handlers. The action target is a separate press-release target: its mouse-down and mouse-up handlers call `stopPropagation()` before the wrapper invokes `props.onMouseUp`, so a press on the action target can neither arm nor toggle the fold target. The divider title itself remains ` Compaction `; the action affordance is the only intentional addition to the collapsed chrome.

The implementation must not silently rely on “expand first, then click body”; the `⋯` target is required in the collapsed state.

## Precise Changes

Expected source changes are limited to the TUI session route, at most one small testable display module for the compaction entry (see Change D), and focused TUI tests. No projection, storage, execution, or keyboard-selection files should change.

### Change A — dedicated render boundary

In `packages/tui/src/routes/session/index.tsx`:

- Keep `UserMessage`'s existing non-compaction branch unchanged.
- Route compaction messages through a dedicated entry or an equivalent branch whose outermost renderable carries `id={props.message.id}` in both states.
- Preserve `alwaysSeparate` registration and existing layout spacing on the stable outer anchor.
- Do not render the same message id on both an expanded body and a divider at once.

### Change B — local fold state and click handling

Use a component-local signal, for example:

```tsx
const [expanded, setExpanded] = createSignal(false)
const foldPress = createPressReleaseClick(() => setExpanded((value) => !value))
```

The exact component shape may differ, but it must satisfy:

- initial `expanded() === false`;
- press/release on the fold target toggles;
- the fold target has a non-zero, hit-testable layout area while preserving the current divider/title visual style;
- drag or mouseout does not toggle;
- local state changes do not call `setPin`, `bumpGroup`, `pinGroupVersion`, or `applyToAll`;
- summary body is mounted only when expanded;
- empty summaries remain render-safe and leave the stable divider/anchor visible.

### Change C — preserve Message Actions

The stable entry must render two distinct mouse targets in the header:

- the centered divider/title area, handled by `foldPress`;
- a right-aligned `⋯` action target, handled by a press-release wrapper around the existing `props.onMouseUp` callback. The action target's mouse-down and mouse-up handlers must stop propagation before/while invoking that wrapper, so a press on the action target cannot arm or toggle the fold target.

The expanded summary body keeps its existing `onMouseUp={props.onMouseUp}` behavior. At minimum:

- opening `DialogMessage` still receives the same `messageID` and `sessionID`;
- Copy continues to read the existing text part;
- Revert and Fork continue to use the existing SDK calls;
- clicking the `⋯` action target does not also toggle the fold;
- clicking the fold target does not unexpectedly open `DialogMessage`.

### Change D — focused TUI tests

Add focused entry tests using the existing OpenTUI `testRender`/mock mouse harness. Because the current `UserMessage` is private to `index.tsx`, either extract the dedicated `CompactionEntry` into a small testable TUI display module or use a route fixture that can render the in-file boundary; do not claim that an unrelated display test exercises a private route component.

Keep route-owned navigation checks separate from entry rendering checks. The route-level test/fixture must verify that the stable id is discoverable through the existing last-user, next/previous, timeline, and fork scroll callbacks; the entry test only verifies the anchor and its local interactions.

Required coverage:

1. compaction starts collapsed and renders the divider/header;
2. the fold target has a non-zero, hit-testable layout area and preserves the divider/title visual style;
3. a normal click inside the fold target expands the full summary;
4. a second normal click collapses it;
5. drag does not toggle;
6. mouseout before release does not toggle;
7. an empty summary does not throw and keeps the header/anchor;
8. non-compaction user-message rendering remains unchanged;
9. the stable `message.id` anchor exists in both collapsed and expanded states and appears exactly once;
10. the action target opens the existing Message Actions path without toggling;
11. action-target drag and mouseout do not open Message Actions;
12. setting/clearing the compaction fold does not change assistant verb-group output or invoke global pin invalidation;
13. compaction rehydration/replay follows the documented local-state behavior without duplicate anchors or visible entries.

The route-level coverage must additionally verify:

14. last-user-message lookup locates a compaction message with a valid text part;
15. next/previous message lookup and timeline/fork `onMove` callbacks can locate the same stable anchor.

The existing bridge tests remain useful for verifying that the input shape is unchanged, but they do not replace these render and interaction tests.

## Safety Analysis

| # | Claim | Required evidence |
|---|---|---|
| S1 | Non-compaction user messages preserve visible and interactive behavior | The non-compaction branch is unchanged; tests cover text, file metadata, timestamps/queued state, body click, and no compaction anchor. |
| S2 | Compaction projection and storage are untouched | No diff in `data.tsx`, `sync.tsx`, `session-message-bridge.ts`, SDK types, or core/session code. |
| S3 | Message navigation remains valid | One stable `message.id` anchor is mounted in both states; tests cover last-user-message, next/previous, timeline, and fork navigation lookup. |
| S4 | Message actions remain valid | The action target passes the same session/message ids to `DialogMessage`; action click and fold click are separate event boundaries, and action press-release/mouseout behavior is tested independently. |
| S5 | Fold state cannot affect unrelated tool/reasoning grouping | Compaction uses local component state and never calls the global pin-store writers; assistant verb-group output remains unchanged in tests. |
| S6 | Default behavior matches the request | Auto and manual compaction both start collapsed; a valid click expands the summary; a second valid click collapses it. |
| S7 | No persistence or execution side effects | No KV/localStorage, network, SDK, storage, session execution, or event-projection changes; only TUI render state changes. |
| S8 | No duplicate or missing renderable ids | The anchor is mounted exactly once and remains mounted across state transitions; test asserts uniqueness. |

The prior “byte-for-byte identical” and “no global side effects” claims are intentionally replaced with these narrower, testable claims. Local state is not global persistent state, but its render transitions still affect layout and must be tested.

## Edge Cases

- **Empty summary:** render the divider and stable anchor; expansion is a no-op for body content and must not throw.
- **Long/multiline summary:** collapsed mode must not mount the body; expanded mode renders the original complete text.
- **Multiple compactions:** each message has its own local entry state and unique message anchor; expanding one does not expand another.
- **Rehydrate/replay:** repeated application of the same compaction message/part id must not create duplicate anchors or duplicate visible entries; existing sync idempotence remains unchanged.
- **Compaction rehydrate:** `session.next.compaction.ended` queues `rehydrateAfterCompaction`, which replaces the transcript store from V2 or V1 message data. The implementation must explicitly test and document whether this replacement preserves or remounts the local fold signal; the required default is collapsed after a remount/rehydrate because fold state is transient view state, while summary data and message actions remain available.
- **Route remount/refresh:** fold state may reset to collapsed; durable summary text and message actions remain available.
- **Non-compaction user message with text/files/timestamp/queued state:** existing branch remains unchanged.
- **Message navigation when compaction is last user message:** lookup finds the stable compaction anchor rather than stopping at a missing child.
- **Timeline/fork selection:** selected compaction message id still maps to a renderable anchor and the existing callbacks still work.
- **Mouse drag/mouseout:** neither action nor fold fires unless the relevant press-release contract is satisfied.
- **Divider hit testing:** a border-only empty box is not by itself an interaction contract; the fold target must have explicit non-zero height and tests must use a coordinate inside that row.
- **Action/fold hit targets:** clicking one target must not trigger the other handler; an action-target drag or mouseout must not open `DialogMessage`.
- **Auto/manual reason:** both default to collapsed; `auto` remains data metadata only.

## Testing Plan

Run from `packages/tui`:

```bash
bun typecheck
bun test test/display/compaction-entry.test.tsx test/routes/session/compaction-navigation.test.tsx
bun test test/display/press-release.test.ts
bun test test/cli/tui/session-message-bridge.test.ts test/cli/cmd/tui/sync-v2-bridge.test.tsx
bun test --timeout 30000
```

The two compaction test paths above are the suggested placement per Change D: `test/display/compaction-entry.test.tsx` for entry rendering/interaction and `test/routes/session/compaction-navigation.test.tsx` for route-level navigation integration. The implementation may adjust the names only if the split into entry tests and route integration tests is preserved.

The full-suite baseline currently has known environment/test-isolation failures. The implementation review must report those separately from failures in the new compaction tests. A passing typecheck or bridge test alone is not sufficient evidence for this feature.

## Acceptance Criteria

1. Auto and manual compaction summaries are initially collapsed.
2. The existing centered ` Compaction ` divider remains visible in collapsed mode.
3. A valid fold click expands the complete summary; a second valid fold click collapses it.
4. The stable `message.id` anchor exists exactly once in both states.
5. Last-user-message, next/previous message, timeline, and fork navigation can still locate the compaction message.
6. Copy, Revert, and Fork remain reachable through the explicitly designed action target/path.
7. Non-compaction user-message visible and interactive behavior remains unchanged.
8. Compaction folding does not call global tool/reasoning pin invalidation or change verb-group output.
9. Drag, mouseout, empty summary, multiline summary, multiple compactions, action-target isolation, and replay/rehydration are covered; route-level navigation checks are separate from entry tests.
10. `bun typecheck` and the focused compaction tests pass; full-suite failures, if any, are classified against the known baseline.
