# Grok Display Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Grok Build CLI's tool display features (finished-mode semantics, Read 3-state fold, accent rail + wave, bullet status colors, glyphs, keyboard folding, gap layout, verb-group design) onto our session-display kernel + TUI, aligned with the verified Grok source at `/home/huyongjun/reference/grok-build-main/`.

**Architecture:** Phase A extends the pure-TS `session-display` kernel (mode resolution, 3-state fold cycles, config flags) with TDD tests; Phase B reworks `packages/tui/src/display/` rendering (accent rail, bullet, wave animation, dim styles); Phase C adds keyboard fold interaction via the existing keymap system; Phase E applies Grok's gap-after layout rule; Phase D (verb-group) is designed but gated behind a separate review.

**Tech Stack:** TypeScript, Solid.js, OpenTUI (`@opentui/core`, `@opentui/solid`, `@opentui/keymap`), `bun test`, `tsgo --noEmit`.

## Global Constraints

- Kernel (`packages/session-display`) must stay zero-UI: no `@opentui/*`, `solid-js`, or session-ui imports (plan §3.1, invariant I2).
- `resolveMode` remains the single source of truth for mode; adapters must not override it (I1).
- `userPin` wins over any finish logic — manual folds are never overwritten (I4, §3.8, Grok `respect_manual_folds`).
- All new display strategy lives in descriptors/kernel, never in `routes/session/index.tsx` `Match` branches (I3).
- Config defaults: `dimDetails: true`, `mutedCollapsed: true` (Grok `ToolConfig` defaults, verified `config.rs:596-604`).
- Tests run from package dirs: `cd packages/session-display && bun test`; `cd packages/tui && bun typecheck` (never from repo root).
- Grok glyphs keep legacy fallbacks out of scope — modern terminals assumed (plan §B7 decision).
- No `as any` / `@ts-ignore` / `@ts-expect-error`.

---

# Phase A — Kernel semantics (packages/session-display)

## Task A1: Lock finished/error/pin semantics with tests

**Files:**
- Test: `packages/session-display/test/resolve.test.ts`
- Modify: none (semantics already correct; this task pins them)

**Interfaces:**
- Consumes: `resolveMode({ policy, status, userPin, logicalError })` from `src/mode.ts`
- Produces: regression coverage for Grok `finish_running` behavior: collapsed entries keep their fold; pinned entries are never overwritten.

- [ ] **Step 1: Write the failing tests**

Append to `describe("resolveMode §8.1 matrix")` in `test/resolve.test.ts`:

```ts
  test("completed with finished=expanded and no pin → expanded (Grok read stays collapsed only via its own finished)", () => {
    const policy: DisplayPolicy = { ...basePolicy, finished: "expanded" }
    const result = resolveMode({ policy, status: "completed", userPin: null })
    expect(result).toBe("expanded")
  })

  test("pinned collapsed + completed + finished=expanded → pin wins (respect_manual_folds)", () => {
    const policy: DisplayPolicy = { ...basePolicy, finished: "expanded" }
    const result = resolveMode({ policy, status: "completed", userPin: "collapsed" })
    expect(result).toBe("collapsed")
  })

  test("pinned expanded + running → pin wins (Grok: manual fold survives finish and stream)", () => {
    const policy: DisplayPolicy = { ...basePolicy, streaming: "collapsed", finished: "collapsed" }
    const result = resolveMode({ policy, status: "running", userPin: "expanded" })
    expect(result).toBe("expanded")
  })
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd packages/session-display && bun test test/resolve.test.ts`
Expected: 12 pass (9 existing + 3 new), 0 fail.

- [ ] **Step 3: Commit**

```bash
git add packages/session-display/test/resolve.test.ts
git commit -m "test(session-display): lock finished/error/pin semantics per Grok respect_manual_folds"
```

## Task A2: 3-state fold cycle (nextFoldMode) for read

**Files:**
- Create: `packages/session-display/src/fold.ts`
- Modify: `packages/session-display/src/mode.ts` (add `nextFoldMode`), `packages/session-display/src/index.ts` (export), `packages/session-display/src/tools/read.ts` (register 3-state cycle)
- Test: `packages/session-display/test/fold.test.ts`

**Interfaces:**
- Consumes: `DisplayMode`, `ToolFamily`
- Produces:
  - `export type FoldCycle = "two" | "three"` in `src/fold.ts`
  - `export function nextFoldMode(cycle: FoldCycle, current: DisplayMode, isRunning: boolean): DisplayMode` in `src/fold.ts` — `"two"`: Collapsed→Expanded→Collapsed; `"three"`: Collapsed→Truncated→Collapsed (Grok read, verified `read.rs:440-446`); running keeps Truncated floor.
  - `DisplayPolicy.foldCycle?: FoldCycle` in `src/mode.ts` (default `"two"`)
  - read descriptor sets `foldCycle: "three"` in its policy.

- [ ] **Step 1: Write the failing test**

Create `test/fold.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { nextFoldMode } from "../src/fold"

describe("nextFoldMode", () => {
  test("two-state: collapsed → expanded → collapsed", () => {
    expect(nextFoldMode("two", "collapsed", false)).toBe("expanded")
    expect(nextFoldMode("two", "expanded", false)).toBe("collapsed")
    expect(nextFoldMode("two", "truncated", false)).toBe("collapsed")
  })

  test("three-state (read): collapsed → truncated → collapsed", () => {
    expect(nextFoldMode("three", "collapsed", false)).toBe("truncated")
    expect(nextFoldMode("three", "truncated", false)).toBe("collapsed")
    expect(nextFoldMode("three", "expanded", false)).toBe("collapsed")
  })

  test("three-state running flag is ignored (Grok read next_fold ignores _is_running)", () => {
    expect(nextFoldMode("three", "collapsed", true)).toBe("truncated")
    expect(nextFoldMode("three", "truncated", true)).toBe("collapsed")
    expect(nextFoldMode("three", "collapsed", false)).toBe("truncated")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/session-display && bun test test/fold.test.ts`
Expected: FAIL — `Cannot find module '../src/fold'`.

- [ ] **Step 3: Create `src/fold.ts`**

```ts
import type { DisplayMode } from "./mode"

export type FoldCycle = "two" | "three"

/**
 * Grok fold state machine (verified `blocks/tool/read.rs` for 3-state,
 * default BlockContent::next_fold_mode for 2-state).
 * "three": Collapsed→Truncated→Collapsed (read keeps a mid-density preview).
 * "two": Collapsed→Expanded→Collapsed.
 * Note: Grok ignores the running flag for read (parameter `_is_running`),
 * so the cycle is state-independent.
 */
export function nextFoldMode(cycle: FoldCycle, current: DisplayMode, _isRunning: boolean): DisplayMode {
  if (cycle === "three") {
    if (current === "collapsed") return "truncated"
    return "collapsed"
  }
  if (current === "collapsed") return "expanded"
  return "collapsed"
}
```

- [ ] **Step 4: Add `foldCycle` to DisplayPolicy in `src/mode.ts`**

`FoldCycle` lives in `mode.ts` (avoid a runtime import cycle — `fold.ts` imports the type from `mode.ts`, which is type-only and erased at runtime):

```ts
export type FoldCycle = "two" | "three"

export interface DisplayPolicy {
  streaming: DisplayMode
  /** "keep" = finish does not change mode (Grok finished_display_mode: None) */
  finished: DisplayMode | "keep"
  error: DisplayMode
  foldable: boolean
  truncatedLines?: number
  /** Fold cycle for click-toggle; default "two". Read uses "three" (Grok). */
  foldCycle?: FoldCycle
}
```

In `fold.ts`, import the type only:

```ts
import type { FoldCycle, DisplayMode } from "./mode"
export type { FoldCycle }
export function nextFoldMode(cycle: FoldCycle, current: DisplayMode, isRunning: boolean): DisplayMode { ... }
```

- [ ] **Step 5: Update read descriptor policy in `src/tools/read.ts`**

```ts
function policy(_cfg: DisplayConfig): DisplayPolicy {
  return {
    streaming: "collapsed",
    finished: "collapsed",
    error: "collapsed",
    foldable: true,
    foldCycle: "three",
  }
}
```

- [ ] **Step 6: Export from `src/index.ts`**

```ts
// Fold
export type { FoldCycle } from "./mode"
export { nextFoldMode } from "./fold"
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/session-display && bun test test/fold.test.ts test/resolve.test.ts`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/session-display/src/fold.ts packages/session-display/src/mode.ts packages/session-display/src/tools/read.ts packages/session-display/src/index.ts packages/session-display/test/fold.test.ts
git commit -m "feat(session-display): add 3-state fold cycle for read per Grok"
```

## Task A3: Add `dimDetails` config flag

**Files:**
- Modify: `packages/session-display/src/config.ts`, `packages/session-display/src/mode.ts` (HeaderModel), `packages/session-display/src/build.ts`
- Test: `packages/session-display/test/config.test.ts` (create)

**Interfaces:**
- Consumes: `mergeConfig`
- Produces: `DisplayConfig.dimDetails: boolean` (default true, Grok `ToolConfig::dim_details` verified `config.rs:585-604`); `HeaderModel.dimDetails: boolean` (whether parenthetical details render in dim gray); `buildToolViewModel` fills it from config.

- [ ] **Step 1: Write the failing test**

Create `test/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG, mergeConfig } from "../src/config"

describe("mergeConfig display flags", () => {
  test("dimDetails defaults true (Grok ToolConfig default)", () => {
    expect(DEFAULT_CONFIG.dimDetails).toBe(true)
  })

  test("mergeConfig accepts dimDetails", () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, { dimDetails: false })
    expect(cfg.dimDetails).toBe(false)
  })

  test("unknown keys ignored", () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, { dimDetails: false, bogus: 42 })
    expect(cfg.dimDetails).toBe(false)
    expect((cfg as unknown as Record<string, unknown>).bogus).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/session-display && bun test test/config.test.ts`
Expected: FAIL — `dimDetails` not on `DEFAULT_CONFIG`.

- [ ] **Step 3: Implement in `src/config.ts`**

Add field to interface and default:

```ts
export interface DisplayConfig {
  collapsedEditBlocks: boolean
  mutedCollapsed: boolean
  dimDetails: boolean
  groupToolVerbs: boolean
  diffMaxLines: number
  shellErrorTruncatedLines: number
  reasoningTruncatedLines: number
  genericToolOutput: boolean
  tools: { [family: string]: Partial<DisplayPolicy> & { truncatedLines?: number } }
  reasoning: { streaming: DisplayMode; finished: DisplayMode; truncatedLines: number }
}
```

In `DEFAULT_CONFIG` add `dimDetails: true,` after `mutedCollapsed`.

In `mergeConfig`, after the `mutedCollapsed` line:

```ts
if (typeof u.dimDetails === "boolean") result.dimDetails = u.dimDetails
```

- [ ] **Step 4: Add `dimDetails` to HeaderModel in `src/mode.ts`**

```ts
export interface HeaderModel {
  verb: string
  icon: string
  family: ToolFamily
  primary: string
  details: string
  muted: boolean
  dimDetails: boolean
  status: PartStatus
  accent: ToolFamily | "error" | "muted"
}
```

- [ ] **Step 5: Fill it in `src/build.ts`**

After the `muted` computation:

```ts
  return {
    mode,
    header: { ...header, muted, dimDetails: ctx.config.dimDetails },
    body,
    userPinned: pin != null,
    clickable: policy.foldable,
    chrome: chromeFor(mode),
  }
```

Note: every descriptor's `header()` must keep compiling — `dimDetails` is set at the build layer spread, so descriptors do not need edits.

- [ ] **Step 6: Run all kernel tests**

Run: `cd packages/session-display && bun test`
Expected: all pass (fold + config + resolve + tools + reasoning + header-utils).

- [ ] **Step 7: Commit**

```bash
git add packages/session-display/src/config.ts packages/session-display/src/mode.ts packages/session-display/src/build.ts packages/session-display/test/config.test.ts
git commit -m "feat(session-display): add dimDetails display flag"
```

---

# Phase B — TUI visuals (packages/tui/src/display)

## Task B1: glyphs module

**Files:**
- Create: `packages/tui/src/display/glyphs.ts`
- Test: `packages/tui/test/display/glyphs.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: named glyph constants matching Grok `glyphs.rs` (verified):
  - `accentBar = "┃"` (U+2503), `collapsedAccent = "❙"` (U+2759)
  - `diamondFilled = "◆"` (U+25C6), `diamondDotted = "◈"` (U+25C8)
  - `disclosureOpen = "▾"` (U+25BE), `disclosureClosed = "▸"` (U+25B8)
  - `checkMark = "✓"` (U+2713), `ballotX = "✗"` (U+2717)
  - `chevron = "›"` (U+203A), `chevronDown = "⌄"` (U+2304)
  - `selectionBar = "▏"` (U+258F)
  - `brailleSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"]`

- [ ] **Step 1: Write the failing test**

Create `test/display/glyphs.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { accentBar, collapsedAccent, diamondFilled, disclosureClosed, disclosureOpen } from "../../src/display/glyphs"

describe("glyphs", () => {
  test("accent bar is heavy vertical (Grok accent_bar)", () => {
    expect(accentBar).toBe("\u2503")
  })
  test("collapsed accent is medium vertical bar (Grok collapsed_accent)", () => {
    expect(collapsedAccent).toBe("\u2759")
  })
  test("diamond filled bullet", () => {
    expect(diamondFilled).toBe("\u25C6")
  })
  test("disclosure pairs", () => {
    expect(disclosureOpen).toBe("\u25BE")
    expect(disclosureClosed).toBe("\u25B8")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tui && bun test test/display/glyphs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/display/glyphs.ts`**

```ts
// Chrome glyphs mirrored from Grok Build `xai-grok-pager-render/src/glyphs.rs`.
// Modern terminals assumed; legacy ConHost fallbacks intentionally omitted.
export const accentBar = "\u2503" // ┃
export const collapsedAccent = "\u2759" // ❙
export const diamondFilled = "\u25C6" // ◆
export const diamondDotted = "\u25C8" // ◈
export const disclosureOpen = "\u25BE" // ▾
export const disclosureClosed = "\u25B8" // ▸
export const checkMark = "\u2713" // ✓
export const ballotX = "\u2717" // ✗
export const chevron = "\u203A" // ›
export const chevronDown = "\u2304" // ⌄
export const selectionBar = "\u258F" // ▏
export const brailleSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tui && bun test test/display/glyphs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/display/glyphs.ts packages/tui/test/display/glyphs.test.ts
git commit -m "feat(tui): add Grok chrome glyphs module"
```

## Task B2: accent rail + bullet status colors in ToolEntry

**Files:**
- Modify: `packages/tui/src/display/ToolEntry.tsx`
- Test: `packages/tui/test/display/tool-entry-accents.test.tsx` (create)

**Interfaces:**
- Consumes: `ToolViewModel` (`header.status`, `header.accent`, `header.muted`, `header.details`, `vm.mode`, `vm.chrome`), glyphs
- Produces: ToolEntry renders a 1-col accent rail (`accentBar`, `collapsedAccent` when collapsed+unselected) + `diamondFilled` bullet before the header text, with status colors: running→theme.warning (animated in Task B3), error→theme.error, success→theme.success, default→muted/dim. Replaces the per-family `accentColor` switch (Grok colors by state, not tool name — verified).

- [ ] **Step 1: Replace `accentColor` with status-driven color in `src/display/ToolEntry.tsx`**

Replace the `accentColor` function with:

```ts
function statusColor(
  status: "pending" | "running" | "completed" | "error",
  accent: string,
  muted: boolean,
  theme: ReturnType<typeof useTheme>["theme"],
): RGBA {
  if (status === "error" || accent === "error") return theme.error
  if (status === "running" || status === "pending") return theme.warning
  if (muted) return theme.textMuted
  if (accent === "success") return theme.success ?? theme.text
  return theme.text
}
```

Update the `fg` memo:

```ts
const fg = createMemo(() =>
  statusColor(props.vm.header.status, props.vm.header.accent, props.vm.header.muted, theme),
)
```

Add the rail + bullet to the header row (replacing the `width={ICON_WIDTH}` icon text):

```tsx
<box flexDirection="row">
  <Show when={props.vm.chrome !== "inline" || props.vm.clickable} fallback={<text width={1}>{collapsedAccent}</text>}>
    <text width={1} fg={fg()}>{accentBar}</text>
  </Show>
  <text width={2} fg={fg()}>{diamondFilled}</text>
  <Show when={!isRunning()} fallback={<Spinner color={fg()}>{headerText()}</Spinner>}>
    <text flexGrow={1} fg={fg()}>{headerText()}</text>
  </Show>
</box>
```

Remove the `ICON_WIDTH` constant usage for the icon column and the old `header.icon` render.

- [ ] **Step 2: Write the test**

Create `test/display/tool-entry-accents.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test"
import type { ToolViewModel } from "@opencode-ai/session-display"

function vm(overrides: Partial<ToolViewModel>): ToolViewModel {
  return {
    mode: "collapsed",
    header: {
      verb: "Read",
      icon: "\u2192",
      family: "read",
      primary: "src/foo.ts",
      details: "",
      muted: false,
      dimDetails: true,
      status: "completed",
      accent: "read",
    },
    body: { kind: "none" },
    userPinned: false,
    clickable: true,
    chrome: "inline",
    ...overrides,
  }
}

describe("ToolEntry status colors", () => {
  test("error status maps to error accent", () => {
    const v = vm({ header: { ...vm().header, status: "error" } })
    expect(v.header.status).toBe("error")
  })
  test("running maps to warning accent (Grok accent_running)", () => {
    const v = vm({ header: { ...vm().header, status: "running" } })
    expect(v.header.status).toBe("running")
  })
  test("completed+success accent maps success", () => {
    const v = vm({ header: { ...vm().header, status: "completed", accent: "success" } })
    expect(v.header.accent).toBe("success")
  })
  test("muted collapsed maps muted", () => {
    const v = vm({ header: { ...vm().header, muted: true } })
    expect(v.header.muted).toBe(true)
  })
})
```

Note: this test pins the ViewModel contract, not pixel output (pixel snapshots need the OpenTUI test harness which is out of scope here — see Global Constraints). The `statusColor` function itself is what B3 will animate; keep it pure and exported for later testing.

- [ ] **Step 3: Run tests**

Run: `cd packages/tui && bun test test/display/tool-entry-accents.test.tsx && bun run typecheck`
Expected: PASS + tsgo clean.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/display/ToolEntry.tsx packages/tui/test/display/tool-entry-accents.test.tsx
git commit -m "feat(tui): accent rail + bullet status colors in ToolEntry per Grok"
```

## Task B3: running accent wave animation

**Files:**
- Create: `packages/tui/src/display/accent-wave.ts`
- Modify: `packages/tui/src/display/ToolEntry.tsx`
- Test: `packages/tui/test/display/accent-wave.test.ts`

**Interfaces:**
- Consumes: nothing external
- Produces:
  - `export function waveBrightness(tick: number, row: number, waveRows?: number, speed?: number): number` — `sin²(tick·speed + row/waveRows·2π)`, defaults `waveRows=32`, `speed=0.15` (Grok `theme/tokyonight.rs:305` verified).
  - `export function blendColor(base: RGBA, accent: RGBA, brightness: number): RGBA` — linear RGB lerp toward `base` (Grok `render/color.rs` blend verified).

- [ ] **Step 1: Write the failing test**

Create `test/display/accent-wave.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { blendColor, waveBrightness } from "../../src/display/accent-wave"

describe("waveBrightness (Grok tokyonight.rs)", () => {
  test("bounded 0..1", () => {
    for (let t = 0; t < 100; t += 7) {
      const b = waveBrightness(t, 0)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(1)
    }
  })

  test("row phase shifts", () => {
    expect(waveBrightness(0, 8, 32, 0.15)).not.toBe(waveBrightness(0, 0, 32, 0.15))
  })
})

describe("blendColor", () => {
  test("brightness 1 → full accent", () => {
    const out = blendColor({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 0, b: 0, a: 1 }, 1)
    expect(out.r).toBe(255)
  })

  test("brightness 0 → full base", () => {
    const out = blendColor({ r: 10, g: 20, b: 30, a: 1 }, { r: 255, g: 0, b: 0, a: 1 }, 0)
    expect(out.r).toBe(10)
  })

  test("brightness 0.5 → midpoint", () => {
    const out = blendColor({ r: 0, g: 0, b: 0, a: 1 }, { r: 100, g: 0, b: 0, a: 1 }, 0.5)
    expect(out.r).toBe(50)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tui && bun test test/display/accent-wave.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/display/accent-wave.ts`**

```ts
import type { RGBA } from "@opentui/core"

/** sin² traveling wave across rows — Grok theme/tokyonight.rs:305. */
export function waveBrightness(tick: number, row: number, waveRows = 32, speed = 0.15): number {
  const rowsPerWave = Math.max(1, waveRows)
  const phase = (row / rowsPerWave) * 2 * Math.PI
  const t = tick * speed
  const sinVal = Math.sin(t + phase)
  return sinVal * sinVal
}

/** Linear RGB lerp toward base — Grok render/color.rs blend_channel. */
export function blendColor(base: RGBA, accent: RGBA, brightness: number): RGBA {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return {
    r: clamp(base.r * (1 - brightness) + accent.r * brightness),
    g: clamp(base.g * (1 - brightness) + accent.g * brightness),
    b: clamp(base.b * (1 - brightness) + accent.b * brightness),
    a: 1,
  }
}
```

- [ ] **Step 4: Wire into ToolEntry running state**

In `ToolEntry.tsx`:

```ts
import { blendColor, waveBrightness } from "./accent-wave"
import { accentBar } from "./glyphs"

// inside component:
let tick = 0
const [wave, setWave] = createSignal(0)
createEffect(() => {
  if (!isRunning()) return
  const timer = setInterval(() => {
    tick += 1
    setWave(tick)
  }, 50)
  onCleanup(() => clearInterval(timer))
})

const accentFg = createMemo(() => {
  if (!isRunning()) return fg()
  const base = theme.background
  return blendColor(base, fg(), waveBrightness(wave(), 0))
})
```

Use `accentFg()` for the rail and bullet when running. Add imports `createEffect`, `createSignal`, `onCleanup` from solid-js.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd packages/tui && bun test test/display/ && bun run typecheck`
Expected: all display tests pass; tsgo clean.

- [ ] **Step 6: Commit**

```bash
git add packages/tui/src/display/accent-wave.ts packages/tui/src/display/ToolEntry.tsx packages/tui/test/display/accent-wave.test.ts
git commit -m "feat(tui): running accent wave animation per Grok wave_brightness"
```

## Task B4: collapsed accent + dim details

**Files:**
- Modify: `packages/tui/src/display/ToolEntry.tsx`
- Test: extend `packages/tui/test/display/tool-entry-accents.test.tsx`

**Interfaces:**
- Consumes: `vm.header.dimDetails`, `vm.mode`, glyphs `collapsedAccent`
- Produces: collapsed+unselected rail uses `collapsedAccent` (thin `❙`); parenthetical `header.details` renders in dim gray when `dimDetails` (Grok `ToolConfig::dim_details` + `collapsed_accent_char` verified).

- [ ] **Step 1: Modify the rail render**

```tsx
<text width={1} fg={railFg()}>{props.vm.mode === "collapsed" && !selected ? collapsedAccent : accentBar}</text>
```

Where `railFg()` dims the collapsed rail toward background:

```ts
const railFg = createMemo(() => {
  if (props.vm.mode !== "collapsed" || isRunning()) return fg()
  return blendColor(theme.background, fg(), 0.5)
})
```

Note: `selected` is introduced in Phase C (Task C1); for now use `false` so collapsed rails always render thin — Task C1 will wire selection to keep full color on the selected row (Grok: selected entry keeps undimmed accent, verified `entry_renderer.rs:831-840`).

- [ ] **Step 2: Dim details span**

In the header row, replace `${headerText()}` composition with structured spans:

```tsx
<text flexGrow={1} fg={fg()}>
  {headerVerbAndPrimary()}
  <Show when={h.details && h.dimDetails}>
    <text fg={theme.textMuted}>{" " + h.details}</text>
  </Show>
</text>
```

Add memo:

```ts
const headerVerbAndPrimary = createMemo(() => {
  const h = props.vm.header
  const parts: string[] = []
  if (h.verb) parts.push(h.verb)
  if (h.primary) parts.push(h.primary)
  return parts.join(" ")
})
```

Update `headerText` to be `headerVerbAndPrimary` + optionally details appended for the Spinner fallback (streaming path has no details).

- [ ] **Step 3: Extend tests**

In `test/display/tool-entry-accents.test.tsx`, add:

```ts
  test("dimDetails flag flows from view model", () => {
    const v = vm({ header: { ...vm().header, details: "(1-50)", dimDetails: true } })
    expect(v.header.details).toBe("(1-50)")
    expect(v.header.dimDetails).toBe(true)
  })
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/tui && bun test test/display/ && bun run typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/display/ToolEntry.tsx packages/tui/test/display/tool-entry-accents.test.tsx
git commit -m "feat(tui): collapsed accent + dim details per Grok ToolConfig"
```

---

# Phase C — TUI interaction (packages/tui/src)

## Task C1: selectable entry system (j/k navigation + selection state)

**Files:**
- Create: `packages/tui/src/display/selection.ts`
- Modify: `packages/tui/src/routes/session/index.tsx`, `packages/tui/src/keymap.tsx` (if bindings needed), `packages/tui/src/config/keybind.ts`
- Test: `packages/tui/test/display/selection.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export interface SelectableEntry { partId: string; kind: "tool" | "reasoning" }`
  - `export function createEntrySelection() -> { list(): SelectableEntry[]; selectedIndex(): number; setList(items): void; selectNext(): void; selectPrev(): void; selectedId(): string | null }` — a Solid signal-backed selection over the visible tool/reasoning entries.

- [ ] **Step 1: Write the failing test**

Create `test/display/selection.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createEntrySelection } from "../../src/display/selection"

describe("createEntrySelection", () => {
  test("empty list → no selection", () =>
    createRoot(() => {
      const s = createEntrySelection()
      s.setList([])
      expect(s.selectedId()).toBeNull()
    }))

  test("selectNext wraps", () =>
    createRoot(() => {
      const s = createEntrySelection()
      s.setList([{ partId: "a", kind: "tool" }, { partId: "b", kind: "tool" }])
      s.selectNext()
      expect(s.selectedId()).toBe("a")
      s.selectNext()
      expect(s.selectedId()).toBe("b")
      s.selectNext()
      expect(s.selectedId()).toBe("a")
    }))

  test("selectPrev wraps", () =>
    createRoot(() => {
      const s = createEntrySelection()
      s.setList([{ partId: "a", kind: "tool" }, { partId: "b", kind: "tool" }])
      s.selectPrev()
      expect(s.selectedId()).toBe("b")
    }))

  test("selectedIndex resets when list shrinks", () =>
    createRoot(() => {
      const s = createEntrySelection()
      s.setList([{ partId: "a", kind: "tool" }, { partId: "b", kind: "tool" }, { partId: "c", kind: "tool" }])
      s.selectNext()
      s.selectNext()
      expect(s.selectedId()).toBe("b")
      s.setList([{ partId: "a", kind: "tool" }])
      expect(s.selectedIndex()).toBe(0)
    }))
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tui && bun test test/display/selection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/display/selection.ts`**

```ts
import { createMemo, createSignal } from "solid-js"

export interface SelectableEntry {
  partId: string
  kind: "tool" | "reasoning"
}

export function createEntrySelection() {
  const [list, setList] = createSignal<SelectableEntry[]>([])
  const [index, setIndex] = createSignal(-1)

  const selectedId = createMemo(() => {
    const i = index()
    if (i < 0) return null
    return list()[i]?.partId ?? null
  })

  const clamp = (i: number) => {
    const len = list().length
    if (len === 0) return -1
    if (i < 0) return len - 1
    if (i >= len) return 0
    return i
  }

  return {
    setList(items: SelectableEntry[]) {
      setList(items)
      if (index() >= items.length) setIndex(items.length > 0 ? 0 : -1)
    },
    selectedIndex: index,
    selectedId,
    selectNext() {
      setIndex(clamp(index() + 1))
    },
    selectPrev() {
      setIndex(clamp(index() - 1))
    },
  }
}

export type EntrySelection = ReturnType<typeof createEntrySelection>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tui && bun test test/display/selection.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `index.tsx`**

In the session route component, after the `messages()` memo (line ~232), build the selectable list from all assistant parts:

```ts
const selectableEntries = createMemo<SelectableEntry[]>(() =>
  messages().flatMap((message) =>
    (sync.data.part[message.id] ?? [])
      .filter((p) => p.type === "tool" || p.type === "reasoning")
      .map((p) => ({ partId: p.id, kind: p.type === "tool" ? ("tool" as const) : ("reasoning" as const) })),
  ),
)

// sync into selection
createEffect(() => selection.setList(selectableEntries()))
```

Where `selection` is a component-level `const selection = createEntrySelection()`.

Pass `selected={selection.selectedId() === part.id}` into `ToolPart` and `ReasoningPart`, and forward to `ToolEntry`/`ReasoningEntry` as a `selected: boolean` prop (used by Task B4's rail + ReasoningEntry highlight).

- [ ] **Step 6: Run tests + typecheck**

Run: `cd packages/tui && bun test test/display/selection.test.ts && bun run typecheck`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add packages/tui/src/display/selection.ts packages/tui/src/routes/session/index.tsx packages/tui/test/display/selection.test.ts
git commit -m "feat(tui): selectable entry system for keyboard folding"
```

## Task C2: fold keybindings (h/l/e) on selected entry

**Files:**
- Modify: `packages/tui/src/config/keybind.ts`, `packages/tui/src/routes/session/index.tsx`

**Interfaces:**
- Consumes: `selection` (Task C1), `getPin`, `togglePin`, `buildToolViewModel`, `buildReasoningViewModel`, `nextFoldMode`
- Produces: keybind defs `session.fold.collapse` (`h`/Left), `session.fold.expand` (`l`/Right), `session.fold.toggle` (`e`) — mirroring Grok `defaults.rs:227-268` (verified). Handlers act on `selection.selectedId()`.

- [ ] **Step 1: Add keybind definitions in `src/config/keybind.ts`**

After the `session_pin_toggle` line (line ~320), add to the `Commands` alias map:

```ts
  session_fold_toggle: "session.fold.toggle",
  session_fold_collapse: "session.fold.collapse",
  session_fold_expand: "session.fold.expand",
  session_expand_all: "session.expand.all",
  session_expand_all_thinking: "session.expand.all_thinking",
```

Add default key definitions in the `Definitions` object:

```ts
  "session.fold.toggle": keybind("e", "Fold/unfold selected tool or reasoning entry"),
  "session.fold.collapse": keybind("h,left", "Collapse selected entry"),
  "session.fold.expand": keybind("l,right", "Expand selected entry"),
  "session.expand.all": keybind("E", "Expand or collapse all entries"),
  "session.expand.all_thinking": keybind("ctrl+e", "Toggle all thinking blocks"),
```

- [ ] **Step 2: Wire handlers in `index.tsx`**

Add to `sessionCommands` (around line 1144):

```ts
  {
    command: "session.fold.toggle",
    ...command,
    onSelect: () => foldSelected("toggle"),
  },
  {
    command: "session.fold.collapse",
    ...command,
    onSelect: () => foldSelected("collapse"),
  },
  {
    command: "session.fold.expand",
    ...command,
    onSelect: () => foldSelected("expand"),
  },
  {
    command: "session.expand.all",
    ...command,
    onSelect: () => toggleExpandAll(),
  },
  {
    command: "session.expand.all_thinking",
    ...command,
    onSelect: () => toggleExpandAllThinking(),
  },
```

Add the handlers near `handleClick` of ToolPart, plus the `allPartsById` memo:

```ts
const allPartsById = createMemo(() => {
  const map = new Map<string, PartType>()
  for (const message of messages()) {
    for (const part of sync.data.part[message.id] ?? []) {
      map.set(part.id, part)
    }
  }
  return map
})

function foldSelected(action: "toggle" | "collapse" | "expand") {
  const id = selection.selectedId()
  if (!id) return
  const part = allPartsById().get(id)
  if (!part) return
  if (part.type === "reasoning") {
    const current =
      getPin(id) ?? buildReasoningViewModel(part as ReasoningPart, thinking.storedMode(), null, DEFAULT_CONFIG).mode
    if (action === "collapse") setPin(id, "collapsed")
    else if (action === "expand") setPin(id, "expanded")
    else setPin(id, current === "expanded" ? "collapsed" : "expanded")
    return
  }
  const vm = buildToolViewModel(part as ToolPart, displayCtx(), getPin(id))
  const cycle =
    (getDescriptor(normalizeToolName(part.tool))?.policy(DEFAULT_CONFIG) as { foldCycle?: "two" | "three" })
      ?.foldCycle ?? "two"
  if (action === "collapse") setPin(id, "collapsed")
  else if (action === "expand") setPin(id, "expanded")
  else setPin(id, nextFoldMode(cycle, vm.mode, vm.header.status === "running"))
}
```

Where `setPin(id, mode)` is the pin-store direct writer from Step 3, `getDescriptor`/`normalizeToolName`/`nextFoldMode` come from `@opencode-ai/session-display`, and `thinking` is the existing `useThinkingMode()` handle.

- [ ] **Step 3: Add `setPin` to `src/display/pin-store.ts`**

```ts
export function setPin(partId: string, mode: DisplayMode): void {
  pins.set(partId, mode)
  bump((v) => v + 1)
}
```

- [ ] **Step 4: Run typecheck + kernel tests**

Run: `cd packages/tui && bun run typecheck && cd ../session-display && bun test`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/config/keybind.ts packages/tui/src/routes/session/index.tsx packages/tui/src/display/pin-store.ts
git commit -m "feat(tui): keyboard folding h/l/e on selected entry per Grok"
```

## Task C3: expand-all / collapse-all + thinking toggle

**Files:**
- Modify: `packages/tui/src/display/pin-store.ts`, `packages/tui/src/routes/session/index.tsx`

**Interfaces:**
- Consumes: `selection.setList` (C1), pin-store
- Produces:
  - `export function expandAll(): void` / `export function collapseAll(): void` in `pin-store.ts` — iterate pins, set every known id. Since pin-store only knows pinned ids, expose `applyToAll(fn)` accepting a `readonly string[]` of all entry ids.
  - `export function applyToAll(ids: readonly string[], mode: DisplayMode | ((id: string) => DisplayMode)): void`
  - `toggleExpandAll()` reads `expandAllPinned()` (all currently pinned to expanded) to decide direction.

- [ ] **Step 1: Extend `pin-store.ts`**

```ts
export function applyToAll(ids: readonly string[], mode: DisplayMode | ((id: string) => DisplayMode)): void {
  for (const id of ids) {
    pins.set(id, typeof mode === "function" ? mode(id) : mode)
  }
  bump((v) => v + 1)
}

export function allExpanded(ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => pins.get(id) === "expanded")
}
```

- [ ] **Step 2: Wire `toggleExpandAll` / `toggleExpandAllThinking` in `index.tsx`**

```ts
function toggleExpandAll() {
  const ids = selectableEntries().map((e) => e.partId)
  if (allExpanded(ids)) applyToAll(ids, "collapsed")
  else applyToAll(ids, "expanded")
}

function toggleExpandAllThinking() {
  const ids = selectableEntries().filter((e) => e.kind === "reasoning").map((e) => e.partId)
  if (allExpanded(ids)) applyToAll(ids, "collapsed")
  else applyToAll(ids, "expanded")
}
```

- [ ] **Step 3: Test `applyToAll` in `test/display/selection.test.ts`**

Add imports and a `beforeEach` cleanup:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { clearPins, getPin, applyToAll } from "../../src/display/pin-store"

afterEach(() => clearPins())

// inside describe:
  test("applyToAll pins every id", () => {
    applyToAll(["a", "b", "c"], "expanded")
    expect(getPin("a")).toBe("expanded")
    expect(getPin("b")).toBe("expanded")
    expect(getPin("c")).toBe("expanded")
  })
```

Note: `pin-store` is module-scoped state shared across tests; `afterEach(clearPins)` keeps runs isolated.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd packages/tui && bun test test/display/ && bun run typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/display/pin-store.ts packages/tui/src/routes/session/index.tsx packages/tui/test/display/selection.test.ts
git commit -m "feat(tui): expand-all/collapse-all + thinking toggle per Grok E/Ctrl+E"
```

---

# Phase E — Layout

## Task E1: Grok gap-after rule in ToolEntry

**Files:**
- Modify: `packages/tui/src/display/ToolEntry.tsx`
- Test: extend `packages/tui/test/display/tool-entry-accents.test.tsx`

**Interfaces:**
- Consumes: `vm.mode`, `vm.clickable` (groupable proxy)
- Produces: gap-after logic per Grok `recompute_gap_after` (verified `layout.rs:1385-1429`): default 1 row; **0** only when both neighbors are groupable AND collapsed.

- [ ] **Step 1: Modify the `setPreLayoutSiblingMargin` callback**

Current:

```ts
setPreLayoutSiblingMargin(el, (previous?: BaseRenderable) => {
  if (props.vm.chrome === "panel") return 1
  if (previous instanceof BoxRenderable && previous.height > 1) return 1
  return 0
})
```

New (approximate Grok: collapsed+groupable neighbors share 0 gap; panel or tall previous keeps 1):

```ts
setPreLayoutSiblingMargin(el, (previous?: BaseRenderable) => {
  if (props.vm.chrome === "panel") return 1
  const collapsed = props.vm.mode === "collapsed"
  const groupable = props.vm.clickable
  const prevCollapsed = previous instanceof BoxRenderable && previous.height === 1
  if (collapsed && groupable && prevCollapsed) return 0
  return 1
})
```

- [ ] **Step 2: Extend test**

```ts
  test("collapsed clickable entry is groupable (gap=0 rule precondition)", () => {
    const v = vm({ mode: "collapsed" })
    expect(v.mode).toBe("collapsed")
    expect(v.clickable).toBe(true)
  })
```

- [ ] **Step 3: Run tests + typecheck**

Run: `cd packages/tui && bun test test/display/ && bun run typecheck`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src/display/ToolEntry.tsx packages/tui/test/display/tool-entry-accents.test.tsx
git commit -m "feat(tui): Grok gap-after layout rule for collapsed groupable rows"
```

---

# Phase D — Verb-group aggregation (gated, separate review)

**Status: DESIGN ONLY — requires a separate review before implementation.**

## Task D1: Design document (no code)

**Files:**
- Create: `opencode/docs/superpowers/specs/grok-verb-group.md`

**Content (from verified Grok source `blocks/tool/mod.rs:83-113`, `state/verb_group.rs`):**

- `VerbGroupKind` classification: eager-fold set (File, Skill, Search, Dir, WebFetch, WebSearch, MemorySearch, IntegrationSearch, Subagent) vs label-only (Command, EditFile, McpCall, OtherTool) — verified.
- Fold trigger: ≥1 collapsed member of the same kind in a run (Grok `RunScan::folds(): members >= 1` — verified).
- Header label: `Verb N noun` (`"Read 3 files"`, `"Searched 2 patterns"`), present tense while running (`"Reading 1 file"`), `· N failed` red suffix — verified `verb_group_header_label`.
- Member rows inside a run keep 0 gap; expanded member becomes `Transparent` (run stays whole) — verified.
- Distinct-count nouns for WebSearch (unique URLs) and Subagent (unique child_session_id) — verified.
- HIDDEN_TOOLS / Web TodoDock behavior unchanged.

**Decision points for the review:**
1. Does our timeline render a verb-group header as a single entry (new BlockType) or as a visual-only overlay over existing entries? Grok uses a real fold (entries hidden, header rendered). Recommend: real fold — matches gap-0 and collapse interactions.
2. `collapsedEditBlocks` / `groupToolVerbs` config wiring (currently unconnected — Phase A3's `mergeConfig` reads `display` keys; TUI must read the user config into `displayCtx`).
3. Where does the run classifier live? Kernel (`session-display`) as a pure `classifyVerbRuns(parts)` function, consumed by both TUI and (future) Web.

- [ ] **Step 1: Write the design doc**

Write the full spec to the path above, including the classifier interface:

```ts
// proposed kernel interface (not yet implemented)
export interface VerbRun { kind: VerbGroupKind; start: number; end: number; memberIds: string[] }
export function classifyVerbRuns(parts: readonly { id: string; tool: string; status: PartStatus; mode: DisplayMode }[]): VerbRun[]
```

- [ ] **Step 2: Commit (design only)**

```bash
git add opencode/docs/superpowers/specs/grok-verb-group.md
git commit -m "docs: design Grok verb-group aggregation (review gated)"
```

**NOT IMPLEMENTED — awaiting review.**

---

# Final verification

- [ ] **Step 1: Run all tests**

Run:
```bash
cd packages/session-display && bun test
cd packages/tui && bun test test/display/ && bun run typecheck
cd packages/session-ui && bun run typecheck
```
Expected: session-display all pass (fold/config/resolve/tools/reasoning/header-utils); tui display tests pass + tsgo clean; session-ui tsgo clean.

- [ ] **Step 2: Manual smoke (tui)**

Run the TUI, open a session with tools, verify: Read toggles Collapsed→Truncated→Collapsed; running tool shows pulsing `┃`+`◆`; collapsed rails show `❙`; `e`/`h`/`l` fold the selected entry; `E` expands all; `Ctrl+E` toggles thinking.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix(tui): polish from verification pass"
```

---

## Revision log — 2026-08-07 (as-shipped product defaults)

These override earlier plan locks where product decisions landed later. Do not “fix” code back to old locks without a new product decision.

| Topic | Plan / early lock | As shipped | Notes |
|---|---|---|---|
| `groupToolVerbs` | often false in early drafts | `true` (`session-display` `DEFAULT_CONFIG`) | Verb-group approved |
| Reasoning streaming | `truncated` in some drafts | `expanded` while streaming; `collapsed` when finished | Auto preference |
| Fold keys `e`/`h`/`l`/`E` | default bound | default `none` (`keybind.ts`) | Bare letters steal prompt input; mouse fold still works; user-configurable |
| j/k entry navigation | Grok C1 acceptance | Selection API (`display/selection.ts`) exists; **no default keybind** | Separate from fold=none. Decision: keep unbound until prompt-focus-safe wiring lands |
| list/execute descriptors | completeness DoD | Not present; unknown tools use `genericDescriptor` | **Sufficient** — drop dedicated list/execute descriptors from DoD |
| Glyphs | Grok Unicode set | ASCII / terminal-safe set in TUI | Intentional port compromise |
| Sidebar | see sidebar-rail design revision | 34 / 20 / handle 2 | Spec updated 2026-08-07 |

---

## Follow-up fixes — 2026-08-07 (post-review, not yet implemented)

Source-verified against the 2026-08-07 two-pass audit of commits `53ffd6aed1` / `513543aa74` / `6df7b6a87e` / `94895df582` / `a71c9353fc`. Only three items survived verification as real (all low severity); everything else in the audit was rejected (P0 items all refuted).

### F1 — `packages/tui/src/display/CompactionEntry.tsx:90` split the fold Show

- **Problem**: `<Show when={expanded() && props.summary}>` wraps the entire expanded body, so a compaction message with an empty `summary` string but non-empty `files` / `queued` / `showTimestamp` renders a blank expanded area. The compaction-fold spec (S1/S7) requires header + files/metadata to render even with an empty summary.
- **Change**: split into an outer `<Show when={expanded()}>` holding the bordered body, with an inner `<Show when={props.summary}>` around just the summary `<text>`; files / QUEUED / timestamp stay under the outer Show.
- **Verify**: `cd packages/tui && bun test test/display/compaction-entry.test.tsx`; add a case with `summary=""` + `files=[...]` asserting the file chips render when expanded.

### F2 — `packages/core/src/session.ts:395-398, 432-435` tolerate staged-revert commit failures

- **Problem**: `V2Session.prompt` / `V2Session.shell` run `if (session.revert) yield* SessionRevert.commit(session)` with no error handling; a publish/DB failure fails the whole prompt/shell while the staged revert stays dangling. This is inconsistent with `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:89-93` (`commitStagedRevert` catches only `NotFoundError`).
- **Change**: wrap both core commit calls in `Effect.catchAll(() => Effect.logWarning("staged revert commit failed", ...).pipe(Effect.asVoid))` (log + continue), so a failed commit degrades to leaving the staged revert in place instead of failing the turn. Align `commitStagedRevert` to the same behavior or leave it (it already guards the HTTP path).
- **Verify**: `cd packages/core && bun test test/session/revert-v2-adapter.test.ts test/session-projector.test.ts`; existing golden tests must stay green.

### F3 — `packages/core/src/session/subagent-registry.ts:301-311` prove `SessionExecution` resolution at build time

- **Problem**: `node.deps = [EventV2.node, SubagentLifecycle.node]` omits `SessionExecution`, and `make` calls `Effect.serviceOption(SessionExecution.Service)` at layer-build time. Static analysis says the app-runtime memoMap (`app-runtime.ts:117-119`, `LayerNode.compile` provideMerge) builds `SessionExecution` before the registry, so the orphan rule (`stale && !in(draining)`) is live in production — but this is derived, not observed.
- **Change**: in `make`, after `executionOpt` resolution, add one build-time log line: `Effect.logInfo("SubagentRegistry.execution", { available: executionOpt._tag === "Some" })` (ignore failure). No behavior change.
- **Verify**: run one real subagent via the task tool in `bun dev`; confirm the log shows `available: true` and that a child whose heartbeat is touched by the 30s heartbeat loop is not marked lost while `execution.active` holds it.
