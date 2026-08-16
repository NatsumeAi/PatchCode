import { TextAttributes } from "@opentui/core"
import { Show, For, createEffect, onCleanup } from "solid-js"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { formatHooksStatus } from "@opencode-ai/core/hooks"

export { formatHooksStatus }

export type HooksStatusData = {
  loaded: { id: string }[]
  untrusted?: boolean
  lastDeny?: { hookId: string; event: string; reason: string }
}

export function HooksStatus(props: { data?: HooksStatusData }) {
  const { theme } = useTheme()
  const sync = useSync()
  const sdk = useSDK()
  const route = useRoute()
  const data = () =>
    props.data ?? {
      loaded: sync.data.hooks.loaded,
      untrusted: sync.data.hooks.untrusted,
      lastDeny: sync.data.hooks.lastDeny,
    }
  const text = () => formatHooksStatus(data())

  createEffect(() => {
    const sessionID = route.data.type === "session" ? route.data.sessionID : sync.data.session[0]?.id
    if (!sessionID) return
    const refresh = () => {
      void sdk
        .fetch(`${sdk.url}/session/${encodeURIComponent(sessionID)}/hooks`)
        .then(async (response) => {
          if (!response.ok) return
          const body = (await response.json()) as HooksStatusData
          sync.set("hooks", {
            loaded: body.loaded ?? [],
            untrusted: body.untrusted === true,
            lastDeny: body.lastDeny,
          })
        })
        .catch(() => {
          /* keep last snapshot from session.hook events */
        })
    }
    refresh()
    const timer = setInterval(refresh, 4000)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Hooks
      </text>
      <Show when={data().untrusted}>
        <text fg={theme.warning}>project: untrusted</text>
      </Show>
      <For each={data().loaded}>{(item) => <text fg={theme.textMuted}>{item.id}</text>}</For>
      <Show when={data().lastDeny}>
        {(deny) => (
          <text fg={theme.error}>
            last deny: {deny().hookId} {deny().event} {deny().reason}
          </text>
        )}
      </Show>
      <text fg={theme.textMuted}>{text()}</text>
    </box>
  )
}
