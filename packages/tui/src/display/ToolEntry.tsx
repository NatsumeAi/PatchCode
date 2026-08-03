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
import { disclosureClosed, disclosureOpen } from "./glyphs"
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

  // Single disclosure glyph: `>` collapsed, `v` expanded/truncated.
  const disclosure = createMemo(() => (props.vm.mode === "collapsed" ? disclosureClosed : disclosureOpen))

  // Always strings — OpenTUI TextNode rejects numbers/objects/undefined as children.
  const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value))

  const headerVerbAndPrimary = createMemo(() => {
    const h = props.vm.header
    const parts: string[] = []
    const verb = str(h.verb)
    const primary = str(h.primary)
    if (verb) parts.push(verb)
    if (primary) parts.push(primary)
    return parts.join(" ")
  })

  const headerDetails = createMemo(() => str(props.vm.header.details))

  const headerText = createMemo(() => {
    const parts = [headerVerbAndPrimary()]
    const details = headerDetails()
    if (details) parts.push(details)
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
        // Always forward click when foldable so expand works even if body is empty.
        if (props.vm.clickable) props.onClick()
      }}
    >
      {/* Header line: `>` / `v` + verb + primary [+ dim details as sibling text] */}
      {/* Never nest <text> inside <text> — OpenTUI TextNode only accepts string/StyledText children. */}
      <box flexDirection="row">
        <text width={BULLET_WIDTH} fg={accentFg()}>
          {str(disclosure()) + " "}
        </text>
        <Show when={!isRunning()} fallback={<Spinner color={fg()}>{headerText()}</Spinner>}>
          <box flexDirection="row" flexGrow={1}>
            <text fg={fg()}>{headerVerbAndPrimary()}</text>
            <Show when={headerDetails() && props.vm.header.dimDetails}>
              <text fg={theme.textMuted}>{" " + headerDetails()}</text>
            </Show>
            <Show when={headerDetails() && !props.vm.header.dimDetails}>
              <text fg={fg()}>{" " + headerDetails()}</text>
            </Show>
          </box>
        </Show>
      </box>

      {/* Body — only when not collapsed */}
      <Show when={props.vm.mode !== "collapsed" && props.vm.body.kind !== "none"}>
        <BodyRenderer body={props.vm.body} width={props.width} />
      </Show>
    </box>
  )
}
