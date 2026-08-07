import { For, Show, createEffect, createSignal, on } from "solid-js"
import { BoxRenderable, type RGBA } from "@opentui/core"
import type { FilePart } from "@opencode-ai/sdk/v2"
import { selectedForeground, useTheme } from "../context/theme"
import { Locale } from "../util/locale"
import { SplitBorder } from "../ui/border"
import { createPressReleaseClick } from "./press-release"

/** Width of the right-aligned message-actions target and its symmetric spacer. */
const ACTION_WIDTH = 3

/**
 * Compaction entry: the summary body is collapsed behind the existing centered
 * ` Compaction ` divider. The outer anchored box always carries the message id
 * so message navigation, timeline jumps, and last-user-message navigation keep
 * working in both states. Folding is component-local view state; it never uses
 * the global tool/reasoning pin store. The right-aligned `⋯` target keeps the
 * existing Message Actions (Copy/Revert/Fork) reachable while collapsed.
 */
export function CompactionEntry(props: {
  messageID: string
  marginTop: number
  summary: string
  files: FilePart[]
  queued: boolean
  created: number
  showTimestamp: boolean
  color: RGBA
  onMouseUp: () => void
  registerAnchor?: (el: BoxRenderable) => void
}) {
  const { theme } = useTheme()
  const [expanded, setExpanded] = createSignal(false)
  const [hover, setHover] = createSignal(false)

  // Fold is transient view state. When rehydrate/replay swaps the message at
  // this list position for a different id, Solid reuses the component
  // instance; reset so a stale expanded state never follows a new message.
  createEffect(on(() => props.messageID, () => setExpanded(false)))

  const foldPress = createPressReleaseClick(() => setExpanded((value) => !value))
  const actionPress = createPressReleaseClick(() => props.onMouseUp())

  const metadataVisible = () => props.queued || props.showTimestamp
  const queuedFg = () => selectedForeground(theme, props.color)

  return (
    <box
      id={props.messageID}
      ref={(el: BoxRenderable) => {
        props.registerAnchor?.(el)
      }}
      marginTop={props.marginTop}
    >
      <box flexDirection="row" height={1} flexShrink={0}>
        {/* Symmetric spacer keeps the centered title optically centered. */}
        <box width={ACTION_WIDTH} flexShrink={0} />
        <box
          flexGrow={1}
          height={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
          onMouseDown={foldPress.onMouseDown}
          onMouseUp={foldPress.onMouseUp}
          onMouseOut={foldPress.onMouseOut}
        />
        {/* Message actions: its own press-release target. Both mouse-down and
            mouse-up stop propagation so a press here can neither arm nor
            toggle the fold target. */}
        <box
          width={ACTION_WIDTH}
          flexShrink={0}
          onMouseDown={(event) => {
            event.stopPropagation()
            actionPress.onMouseDown(event)
          }}
          onMouseUp={(event) => {
            event.stopPropagation()
            actionPress.onMouseUp(event)
          }}
          onMouseOut={() => {
            actionPress.onMouseOut?.()
          }}
        >
          <text fg={theme.textMuted}>⋯</text>
        </box>
      </box>
      <Show when={expanded()}>
        <box
          border={["left"]}
          borderColor={props.color}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={1}
        >
          <box
            onMouseOver={() => setHover(true)}
            onMouseOut={() => setHover(false)}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <Show when={props.summary}>
              <text fg={theme.text}>{props.summary}</text>
            </Show>
            <Show when={props.files.length}>
              <box
                flexDirection="row"
                paddingBottom={metadataVisible() ? 1 : 0}
                paddingTop={1}
                gap={1}
                flexWrap="wrap"
              >
                <For each={props.files}>
                  {(file) => {
                    const directory = file.mime === "application/x-directory"
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: theme.secondary, fg: theme.background }}>
                          {directory ? " Directory " : " File "}
                        </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}>
                          {" "}
                          {file.filename ?? file.url}{" "}
                        </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={props.queued}
              fallback={
                <Show when={props.showTimestamp}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: props.color, fg: queuedFg(), bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
    </box>
  )
}
