import { createMemo, Show } from "solid-js"
import { BoxRenderable, type BaseRenderable } from "@opentui/core"
import type { ReasoningViewModel } from "@opencode-ai/session-display"
import { formatDuration } from "@opencode-ai/session-display"
import { useTheme, createSyntaxStyleMemo, generateSubtleSyntax } from "../context/theme"
import { Spinner } from "../component/spinner"
import { setPreLayoutSiblingMargin } from "../util/layout"
import { disclosureClosed, disclosureOpen } from "./glyphs"

const BULLET_WIDTH = 2

/**
 * Reasoning/Thought row — same chrome as ToolEntry:
 * `>` collapsed, `v` expanded/truncated; click toggles fold; body below.
 */
export function ReasoningEntry(props: {
  vm: ReasoningViewModel
  onClick: () => void
  conceal: boolean
  selected?: boolean
}) {
  const { theme } = useTheme()
  const syntax = createSyntaxStyleMemo(() => generateSubtleSyntax(theme))

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

  const showBody = createMemo(() => {
    if (props.vm.mode === "expanded") return true
    if (props.vm.mode === "truncated" && (isStreaming() || props.vm.body.length > 0)) return true
    return false
  })

  const bodyText = createMemo(() => {
    if (props.vm.mode === "expanded") return props.vm.body
    // truncated: last few lines while streaming / preview
    const lines = props.vm.body.split("\n")
    if (lines.length <= 3) return props.vm.body
    return lines.slice(-3).join("\n")
  })

  return (
    <Show when={props.vm.body || isStreaming()}>
      <box
        paddingLeft={2}
        ref={(el: BoxRenderable) => {
          setPreLayoutSiblingMargin(el, (_previous?: BaseRenderable) => 1)
        }}
        onMouseUp={() => {
          if (props.vm.clickable) props.onClick()
        }}
      >
        {/* Header — isomorphic with ToolEntry */}
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

        {/* Body — only when not collapsed */}
        <Show when={showBody() && bodyText()}>
          <box paddingLeft={BULLET_WIDTH} marginTop={1}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={bodyText()}
              conceal={props.conceal}
              fg={theme.textMuted}
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}
