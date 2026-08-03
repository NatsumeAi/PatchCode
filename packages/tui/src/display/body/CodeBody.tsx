import type { BodyModel } from "@opencode-ai/session-display"
import { useTheme } from "../../context/theme"
import { filetype } from "../../util/filetype"

export function CodeBody(props: { body: Extract<BodyModel, { kind: "code" }> }) {
  const { theme, syntax } = useTheme()
  const maxLines = props.body.maxLines ?? 500
  const lines = props.body.content.split("\n")
  const truncated = lines.length > maxLines
  const displayContent = truncated ? lines.slice(0, maxLines).join("\n") : props.body.content

  return (
    <box paddingLeft={1}>
      <code
        filetype={filetype(props.body.path)}
        syntaxStyle={syntax()}
        content={displayContent}
        fg={theme.text}
      />
      {truncated && (
        <text fg={theme.textMuted}>{"\u2026"} ({lines.length - maxLines} more lines)</text>
      )}
    </box>
  )
}
