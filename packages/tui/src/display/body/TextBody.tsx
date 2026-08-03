import { Show } from "solid-js"
import type { BodyModel } from "@opencode-ai/session-display"
import { useTheme } from "../../context/theme"

export function TextBody(props: { body: Extract<BodyModel, { kind: "text" }> }) {
  const { theme } = useTheme()
  const maxLines = props.body.maxLines ?? 20
  const lines = props.body.text.split("\n")
  const truncated = lines.length > maxLines
  const displayText = truncated ? lines.slice(0, maxLines).join("\n") : props.body.text

  return (
    <box>
      <text fg={theme.text}>{displayText}</text>
      <Show when={truncated}>
        <text fg={theme.textMuted}>{"\u2026"} ({lines.length - maxLines} more lines)</text>
      </Show>
    </box>
  )
}
