import { Show } from "solid-js"
import type { BodyModel } from "@opencode-ai/session-display"
import { useTheme } from "../../context/theme"
import { filetype } from "../../util/filetype"

export function DiffBody(props: { body: Extract<BodyModel, { kind: "diff" }> }) {
  const { theme, syntax } = useTheme()
  return (
    <box paddingLeft={1}>
      <diff
        diff={props.body.diff}
        view="unified"
        filetype={filetype(props.body.path)}
        syntaxStyle={syntax()}
        showLineNumbers={true}
        width="100%"
        fg={theme.text}
        addedBg={theme.diffAddedBg}
        removedBg={theme.diffRemovedBg}
        contextBg={theme.diffContextBg}
        addedSignColor={theme.diffHighlightAdded}
        removedSignColor={theme.diffHighlightRemoved}
        lineNumberFg={theme.diffLineNumber}
        lineNumberBg={theme.diffContextBg}
        addedLineNumberBg={theme.diffAddedLineNumberBg}
        removedLineNumberBg={theme.diffRemovedLineNumberBg}
      />
    </box>
  )
}
