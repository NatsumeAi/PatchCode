import { For } from "solid-js"
import type { BodyModel } from "@opencode-ai/session-display"
import { useTheme } from "../../context/theme"

export function QaBody(props: { body: Extract<BodyModel, { kind: "qa" }> }) {
  const { theme } = useTheme()
  return (
    <box gap={1}>
      <For each={props.body.items}>
        {(item) => (
          <box flexDirection="column">
            <text fg={theme.textMuted}>{item.question}</text>
            <text fg={theme.text}>{item.answer}</text>
          </box>
        )}
      </For>
    </box>
  )
}
