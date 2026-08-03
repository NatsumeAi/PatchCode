import { For, Show } from "solid-js"
import type { BodyModel } from "@opencode-ai/session-display"
import { useTheme } from "../../context/theme"

export function LinesBody(props: { body: Extract<BodyModel, { kind: "lines" }> }) {
  const { theme } = useTheme()
  const maxLines = props.body.maxLines ?? 20
  const lines = () => props.body.lines.slice(0, maxLines)
  const overflow = () => props.body.lines.length > maxLines

  return (
    <box gap={0}>
      <For each={lines()}>
        {(line) => (
          <text fg={theme.text}>{line}</text>
        )}
      </For>
      <Show when={overflow()}>
        <text fg={theme.textMuted}>{"\u2026"} ({props.body.lines.length - maxLines} more lines)</text>
      </Show>
    </box>
  )
}
