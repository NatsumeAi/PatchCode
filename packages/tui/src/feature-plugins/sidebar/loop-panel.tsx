import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"

const id = "internal:sidebar-loop"

export type LoopSnapshot = {
  goal?: string
  budget?: string
  terminal?: string
  breaker?: string
  edges?: string
  worker?: string
  verifier?: string
  timer?: string
  subagents?: string
}

export function parseStatusText(text: string): LoopSnapshot {
  const pick = (label: string) => {
    const re = new RegExp(`^${label}\\s*:\\s*(.*)$`, "im")
    const m = text.match(re)
    return m?.[1]?.trim()
  }
  return {
    goal: pick("Goal"),
    worker: pick("Worker"),
    verifier: pick("Verifier"),
    budget: pick("Budget"),
    breaker: pick("Breaker"),
    edges: pick("SpawnEdges"),
    timer: pick("Timer"),
    terminal: pick("Terminal"),
  }
}

/**
 * Live loop-control panel: polls `/loop status` via session.command and shows
 * goal / worker / verifier / budget / timer / terminal / breaker / spawn edges.
 */
export function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const [snap, setSnap] = createSignal<LoopSnapshot | undefined>(undefined)
  const theme = () => props.api.theme.current

  const isWorking = (sessionID: string) => props.api.state.session.status(sessionID)?.type === "busy"
  const activeChildren = createMemo(() => {
    const sessions = props.api.state.session.list() as Array<{ id: string; parentID?: string }>
    return sessions.filter((s) => s.parentID === props.session_id && isWorking(s.id)).length
  })

  const refresh = () => {
    void props.api.client.session
      .command({
        sessionID: props.session_id,
        command: "loop",
        arguments: "status",
      })
      .then((result) => {
        // Response shape: { info, parts: [{ text }] } or similar
        const data = result as { data?: { parts?: Array<{ text?: string }> }; parts?: Array<{ text?: string }> }
        const parts = data?.data?.parts ?? data?.parts ?? []
        const text = parts
          .map((p) => p.text)
          .filter(Boolean)
          .join("\n")
        if (text) setSnap(parseStatusText(text))
      })
      .catch(() => {
        /* keep last snapshot */
      })
  }

  createEffect(() => {
    // Re-bind when session changes
    void props.session_id
    refresh()
    const timer = setInterval(refresh, 4000)
    onCleanup(() => clearInterval(timer))
  })

  const display = createMemo(() => {
    const s = snap()
    if (!s) return undefined
    const edges = s.edges ?? "0 open"
    const busy = activeChildren()
    return {
      ...s,
      subagents: `${edges}; ${busy} busy`,
    }
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
          when={display()}
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
              <text fg={theme().textMuted}>worker: {l().worker ?? "—"}</text>
              <text fg={theme().textMuted}>verifier: {l().verifier ?? "—"}</text>
              <text fg={theme().textMuted}>budget: {l().budget ?? "—"}</text>
              <text fg={theme().textMuted}>timer: {l().timer ?? "—"}</text>
              <text fg={theme().textMuted}>terminal: {l().terminal ?? "running"}</text>
              <text fg={theme().textMuted}>breaker: {l().breaker ?? "—"}</text>
              <text fg={theme().textMuted}>subagents: {l().subagents ?? "—"}</text>
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
