import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createSignal, For, Show } from "solid-js"

const id = "internal:sidebar-subagents"

/** Pure: filter sessions to the ones this session spawned, working first. */
export function subagentsOf<Item extends { id: string; parentID?: string }>(
  sessions: ReadonlyArray<Item>,
  parent: string,
  isWorking: (id: string) => boolean,
) {
  return sessions
    .filter((item) => item.parentID === parent)
    .toSorted((a, b) => {
      const aWorking = isWorking(a.id) ? 0 : 1
      const bWorking = isWorking(b.id) ? 0 : 1
      return aWorking - bWorking
    })
}

export function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current

  // Sessions whose parent is this session are its subagents. list() is a
  // reactive array (sync.data.session), so new/updated sessions re-render.
  const isWorking = (sessionID: string) => props.api.state.session.status(sessionID)?.type === "busy"
  const subagents = createMemo(() =>
    subagentsOf(props.api.state.session.list(), props.session_id, isWorking),
  )
  const working = createMemo(() => subagents().filter((item) => isWorking(item.id)).length)

  const dot = (sessionID: string) => (isWorking(sessionID) ? theme().warning : theme().success)

  return (
    <Show when={true}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => subagents().length > 2 && setOpen((x) => !x)}>
          <Show when={subagents().length > 2}>
            <text fg={theme().text}>{open() ? "v" : ">"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Subagents</b>
            <Show when={!open()}>
              <span style={{ fg: theme().textMuted }}>
                {" "}
                ({working()} active)
              </span>
            </Show>
          </text>
        </box>
        <Show when={subagents().length <= 2 || open()}>
          <For each={subagents()}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} style={{ fg: dot(item.id) }}>
                  •
                </text>
                <text fg={theme().text} wrapMode="word">
                  {item.agent ?? "subagent"}
                </text>
                <text fg={theme().textMuted} wrapMode="word">
                  {item.title.slice(0, 24)}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const reg = api.slots.register({
    order: 101,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
