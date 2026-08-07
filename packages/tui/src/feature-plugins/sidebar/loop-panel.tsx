import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, Show } from "solid-js"

const id = "internal:sidebar-loop"

/**
 * Minimal loop-control panel: shows goal / budget / terminal when the client
 * exposes them on session meta. Falls back to a short hint to use /loop status.
 */
export function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current

  // Prefer live status if the sync layer attaches loop fields; otherwise hint.
  const loop = createMemo(() => {
    const sessions = props.api.state.session.list() as Array<{
      id: string
      title?: string
      meta?: { loop?: { goal?: string; budget?: string; terminal?: string } }
    }>
    const s = sessions.find((x) => x.id === props.session_id)
    return s?.meta?.loop
  })

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
        <text fg={theme().text}>
          <b>Loop</b>
        </text>
        <text fg={theme().textMuted}>{open() ? "v" : ">"}</text>
      </box>
      <Show when={open()}>
        <Show
          when={loop()}
          fallback={
            <text fg={theme().textMuted} wrapMode="word">
              /loop status · /loop goal &lt;text&gt;
            </text>
          }
        >
          {(l) => (
            <box>
              <text fg={theme().textMuted} wrapMode="word">
                goal: {(l().goal ?? "").slice(0, 48) || "(empty)"}
              </text>
              <text fg={theme().textMuted}>budget: {l().budget ?? "—"}</text>
              <text fg={theme().textMuted}>terminal: {l().terminal ?? "running"}</text>
            </box>
          )}
        </Show>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const reg = api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
  return () => reg()
}

export default {
  id,
  tui,
} satisfies BuiltinTuiPlugin
