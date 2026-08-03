import { createMemo, Show } from "solid-js"
import { BoxRenderable } from "@opentui/core"
import type { ReasoningViewModel } from "@opencode-ai/session-display"
import { formatDuration } from "@opencode-ai/session-display"
import { useTheme, createSyntaxStyleMemo, generateSubtleSyntax } from "../context/theme"
import { Spinner } from "../component/spinner"
import { setPreLayoutSiblingMargin } from "../util/layout"

export function ReasoningEntry(props: {
  vm: ReasoningViewModel
  onClick: () => void
  conceal: boolean
  selected?: boolean
}) {
  const { theme } = useTheme()
  const syntax = createSyntaxStyleMemo(() => generateSubtleSyntax(theme))

  const headerColor = () => (props.selected ? theme.text : theme.warning)

  const headerText = createMemo(() => {
    if (props.vm.status === "streaming") {
      return props.vm.title ? `Thinking: ${props.vm.title}` : "Thinking"
    }
    const parts: string[] = ["Thought"]
    if (props.vm.title) parts.push(`: ${props.vm.title}`)
    if (props.vm.durationMs != null) parts.push(` \u00B7 ${formatDuration(props.vm.durationMs)}`)
    return parts.join("")
  })

  const showBody = createMemo(() => {
    if (props.vm.mode === "expanded") return true
    if (props.vm.mode === "truncated" && props.vm.status === "streaming") return true
    return false
  })

  const truncatedBody = createMemo(() => {
    if (props.vm.mode !== "truncated") return props.vm.body
    const lines = props.vm.body.split("\n")
    if (lines.length <= 3) return props.vm.body
    return lines.slice(-3).join("\n")
  })

  return (
    <Show when={props.vm.body || props.vm.status === "streaming"}>
      <box
        ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
        paddingLeft={3}
        marginTop={1}
        flexDirection="column"
        flexShrink={0}
      >
        <box onMouseUp={() => props.onClick()}>
          <Show
            when={props.vm.status === "done"}
            fallback={<Spinner color={theme.warning}>{headerText()}</Spinner>}
          >
            <text fg={headerColor()} wrapMode="none">
              <Show when={props.vm.mode !== "expanded"}>
                <span>{props.vm.mode === "collapsed" ? "+ " : "- "}</span>
              </Show>
              <span>{headerText()}</span>
            </text>
          </Show>
        </box>
        <Show when={showBody() && (props.vm.mode === "expanded" ? props.vm.body : truncatedBody())}>
          <box paddingLeft={props.vm.mode === "expanded" ? 0 : 2} marginTop={1}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={props.vm.mode === "expanded" ? props.vm.body : truncatedBody()}
              conceal={props.conceal}
              fg={theme.textMuted}
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}

const alwaysSeparate = new WeakSet<BoxRenderable>()
