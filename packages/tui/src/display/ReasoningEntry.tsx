import { createMemo, Show } from "solid-js"
import { BoxRenderable, type BaseRenderable } from "@opentui/core"
import type { ReasoningViewModel } from "@opencode-ai/session-display"
import { formatDuration } from "@opencode-ai/session-display"
import { useTheme } from "../context/theme"
import { Spinner } from "../component/spinner"
import { setPreLayoutSiblingMargin } from "../util/layout"
import { disclosureClosed, disclosureOpen } from "./glyphs"
import { createPressReleaseClick } from "./press-release"

const BULLET_WIDTH = 2

/**
 * Reasoning/Thought row — same chrome as ToolEntry:
 * `>` collapsed, `v` expanded/truncated; click toggles fold; body below.
 *
 * Performance: body is plain <text>, not <code filetype=markdown>. Expanding a
 * finished thought must not re-parse markdown / remount a syntax highlighter —
 * that was the "expand causes full refresh lag" path.
 */
export function ReasoningEntry(props: {
  vm: ReasoningViewModel
  onClick: () => void
  conceal: boolean
  selected?: boolean
}) {
  const { theme } = useTheme()

  const isStreaming = createMemo(() => props.vm.status === "streaming")
  const fg = createMemo(() => (props.selected ? theme.text : theme.warning))
  const disclosure = createMemo(() => (props.vm.mode === "collapsed" ? disclosureClosed : disclosureOpen))

  const headerPrimary = createMemo(() => {
    if (isStreaming()) {
      return props.vm.title ? `Thinking: ${props.vm.title}` : "Thinking"
    }
    return props.vm.title ? `Thought: ${props.vm.title}` : "Thought"
  })

  const durationLabel = createMemo(() => {
    if (props.vm.durationMs == null) return ""
    const label = formatDuration(props.vm.durationMs)
    return label ? ` · ${label}` : ""
  })

  const showBody = createMemo(() => props.vm.mode !== "collapsed")

  // Expanded: full body. Truncated (rare with expanded-default streaming): tail lines.
  const bodyText = createMemo(() => {
    const body = props.vm.body
    if (!body) return ""
    if (props.vm.mode === "expanded") return body
    const lines = body.split("\n")
    if (lines.length <= 3) return body
    return lines.slice(-3).join("\n")
  })

  const press = createPressReleaseClick(() => {
    if (props.vm.clickable) props.onClick()
  })

  return (
    <Show when={props.vm.body || props.vm.title || isStreaming() || props.vm.durationMs != null}>
      <box
        paddingLeft={2}
        ref={(el: BoxRenderable) => {
          setPreLayoutSiblingMargin(el, (_previous?: BaseRenderable) => 1)
        }}
        onMouseDown={press.onMouseDown}
        onMouseUp={press.onMouseUp}
        onMouseOut={press.onMouseOut}
      >
        <box flexDirection="row">
          <text width={BULLET_WIDTH} fg={fg()}>
            {disclosure()}{" "}
          </text>
          <Show when={!isStreaming()} fallback={<Spinner color={theme.warning}>{headerPrimary()}</Spinner>}>
            <text flexGrow={1} fg={fg()} wrapMode="none">
              {headerPrimary()}
              <Show when={durationLabel()}>
                <span style={{ fg: theme.textMuted }}>{durationLabel()}</span>
              </Show>
            </text>
          </Show>
        </box>

        {/* Keep body as cheap plain text; mount only when not collapsed. */}
        <Show when={showBody() && bodyText()}>
          <box paddingLeft={BULLET_WIDTH} marginTop={1}>
            <text fg={theme.textMuted} wrapMode="word">
              {bodyText()}
            </text>
          </box>
        </Show>
      </box>
    </Show>
  )
}
