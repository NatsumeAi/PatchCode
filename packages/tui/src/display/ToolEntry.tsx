import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { BoxRenderable, type BaseRenderable, type RGBA } from "@opentui/core"
import type { ToolViewModel, BodyModel, PartStatus } from "@opencode-ai/session-display"
import { useTheme } from "../context/theme"
import { Spinner } from "../component/spinner"
import { DiffBody } from "./body/DiffBody"
import { LinesBody } from "./body/LinesBody"
import { TodosBody } from "./body/TodosBody"
import { QaBody } from "./body/QaBody"
import { CodeBody } from "./body/CodeBody"
import { PatchBody } from "./body/PatchBody"
import { TextBody } from "./body/TextBody"
import { setPreLayoutSiblingMargin } from "../util/layout"
import { accentBar, collapsedAccent, diamondFilled } from "./glyphs"
import { blendColor, waveBrightness } from "./accent-wave"

const BULLET_WIDTH = 2

/** Grok colors tool rows by status, not tool name. */
export function statusColor(
  status: PartStatus,
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

function BodyRenderer(props: { body: BodyModel; width: number }) {
  return (
    <Show when={props.body.kind !== "none"}>
      <box paddingLeft={BULLET_WIDTH} marginTop={1}>
        <Show when={props.body.kind === "diff"}>
          <DiffBody body={props.body as Extract<BodyModel, { kind: "diff" }>} />
        </Show>
        <Show when={props.body.kind === "lines"}>
          <LinesBody body={props.body as Extract<BodyModel, { kind: "lines" }>} />
        </Show>
        <Show when={props.body.kind === "todos"}>
          <TodosBody body={props.body as Extract<BodyModel, { kind: "todos" }>} />
        </Show>
        <Show when={props.body.kind === "qa"}>
          <QaBody body={props.body as Extract<BodyModel, { kind: "qa" }>} />
        </Show>
        <Show when={props.body.kind === "code"}>
          <CodeBody body={props.body as Extract<BodyModel, { kind: "code" }>} />
        </Show>
        <Show when={props.body.kind === "patch"}>
          <PatchBody body={props.body as Extract<BodyModel, { kind: "patch" }>} />
        </Show>
        <Show when={props.body.kind === "text"}>
          <TextBody body={props.body as Extract<BodyModel, { kind: "text" }>} />
        </Show>
      </box>
    </Show>
  )
}

export function ToolEntry(props: {
  vm: ToolViewModel
  partId: string
  onClick: () => void
  width: number
  selected?: boolean
}) {
  const { theme } = useTheme()

  const isRunning = createMemo(() => props.vm.header.status === "pending" || props.vm.header.status === "running")
  const fg = createMemo(() =>
    statusColor(props.vm.header.status, props.vm.header.accent, props.vm.header.muted, theme),
  )

  // Grok accent wave: running rows pulse the rail/bullet toward background.
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

  const accentFg = createMemo(() => {
    if (!isRunning()) return fg()
    return blendColor(theme.background, fg(), waveBrightness(waveTick(), 0))
  })

  // Grok: collapsed+unselected rail uses thin ❙ dimmed toward bg; selected or
  // expanded keeps full accentBar at full color.
  const railFg = createMemo(() => {
    if (props.vm.mode !== "collapsed" || isRunning() || props.selected) return fg()
    return blendColor(theme.background, fg(), 0.5)
  })
  const railGlyph = createMemo(() =>
    props.vm.mode === "collapsed" && !isRunning() && !props.selected ? collapsedAccent : accentBar,
  )

  const headerVerbAndPrimary = createMemo(() => {
    const h = props.vm.header
    const parts: string[] = []
    if (h.verb) parts.push(h.verb)
    if (h.primary) parts.push(h.primary)
    return parts.join(" ")
  })

  const headerText = createMemo(() => {
    const h = props.vm.header
    const parts = [headerVerbAndPrimary()]
    if (h.details) parts.push(h.details)
    return parts.join(" ")
  })

  return (
    <box
      paddingLeft={2}
      ref={(el: BoxRenderable) => {
        setPreLayoutSiblingMargin(el, (previous?: BaseRenderable) => {
          // Grok recompute_gap_after: panel keeps 1; collapsed+groupable
          // neighbors share 0 so a folded run reads as one unit.
          if (props.vm.chrome === "panel") return 1
          const collapsed = props.vm.mode === "collapsed"
          const groupable = props.vm.clickable
          const prevCollapsed = previous instanceof BoxRenderable && previous.height === 1
          if (collapsed && groupable && prevCollapsed) return 0
          return 1
        })
      }}
      onMouseUp={() => {
        if (props.vm.clickable) props.onClick()
      }}
    >
      {/* Header line */}
      <box flexDirection="row">
        <text width={1} fg={railFg()}>
          {railGlyph()}
        </text>
        <text width={BULLET_WIDTH} fg={accentFg()}>
          {diamondFilled}
        </text>
        <Show when={!isRunning()} fallback={<Spinner color={fg()}>{headerText()}</Spinner>}>
          <text flexGrow={1} fg={fg()}>
            {headerVerbAndPrimary()}
            <Show when={props.vm.header.details && props.vm.header.dimDetails}>
              <text fg={theme.textMuted}> {props.vm.header.details}</text>
            </Show>
          </text>
        </Show>
      </box>

      {/* Body — only when not collapsed */}
      <Show when={props.vm.mode !== "collapsed" && props.vm.body.kind !== "none"}>
        <BodyRenderer body={props.vm.body} width={props.width} />
      </Show>
    </box>
  )
}
