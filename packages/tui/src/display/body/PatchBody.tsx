import { For, Show } from "solid-js"
import type { BodyModel } from "@opencode-ai/session-display"
import { useTheme } from "../../context/theme"
import { filetype } from "../../util/filetype"

export function PatchBody(props: { body: Extract<BodyModel, { kind: "patch" }> }) {
  const { theme, syntax } = useTheme()

  return (
    <box gap={1}>
      <For each={props.body.files}>
        {(file) => (
          <box flexDirection="column">
            <text fg={theme.textMuted}>
              {file.type === "delete" ? "Deleted " : file.type === "add" ? "Created " : "Patched "}
              {file.path}
            </text>
            <Show when={file.type !== "delete" && file.diff}>
              <box paddingLeft={1}>
                <diff
                  diff={file.diff}
                  view="unified"
                  filetype={filetype(file.path)}
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
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}
