import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { BoxRenderable, type BaseRenderable, type RGBA } from "@opentui/core"
import type { VerbRun } from "@opencode-ai/session-display"
import { useTheme } from "../context/theme"
import { setPreLayoutSiblingMargin } from "../util/layout"
import { disclosureClosed, disclosureOpen } from "./glyphs"
import { blendColor, waveBrightness } from "./accent-wave"
import { createPressReleaseClick } from "./press-release"

const BULLET_WIDTH = 2

/** Status-driven color shared with ToolEntry (Grok colors by status). */
function runColor(run: VerbRun, selected: boolean, theme: ReturnType<typeof useTheme>["theme"]): RGBA {
  if (selected) return theme.text
  if (run.running) return theme.warning
  if (run.failedCount > 0) return theme.error
  return theme.textMuted
}

export function VerbGroupHeader(props: {
  run: VerbRun
  label: string
  expanded: boolean
  onToggle: () => void
  selected?: boolean
}) {
  const { theme } = useTheme()

  const isRunning = () => props.run.running
  const [waveTick, setWaveTick] = createSignal(0)
  createEffect(() => {
    if (!isRunning()) {
      setWaveTick(0)
      return
    }
    let tick = 0
    const timer = setInterval(() => {
      tick += 1
      setWaveTick(tick)
    }, 50)
    onCleanup(() => clearInterval(timer))
  })

  const fg = createMemo(() => runColor(props.run, props.selected ?? false, theme))
  const accentFg = createMemo(() => {
    if (!isRunning()) return fg()
    return blendColor(theme.background, fg(), waveBrightness(waveTick(), 0))
  })

  const press = createPressReleaseClick(() => props.onToggle())

  return (
    <box
      paddingLeft={2}
      ref={(el: BoxRenderable) => {
        setPreLayoutSiblingMargin(el, (previous?: BaseRenderable) => {
          if (previous instanceof BoxRenderable && previous.height > 1) return 1
          return 1
        })
      }}
      onMouseDown={press.onMouseDown}
      onMouseUp={press.onMouseUp}
      onMouseOut={press.onMouseOut}
    >
      <box flexDirection="row">
        <text width={BULLET_WIDTH} fg={accentFg()}>
          {props.expanded ? disclosureOpen : disclosureClosed}{" "}
        </text>
        <text flexGrow={1} fg={fg()}>
          {props.label}
        </text>
        <Show when={props.run.failedCount > 0}>
          <text fg={theme.error}> · {props.run.failedCount} failed</text>
        </Show>
      </box>
    </box>
  )
}
