import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"
import { useDialog } from "./ui/dialog"
import { DialogConfirm } from "./ui/dialog-confirm"
import { useTheme } from "./context/theme"
import { useSDK } from "./context/sdk"
import { useBindings } from "./keymap"

export type MemoryFileEntry = {
  path: string
  name: string
  kind: "global" | "workspace" | "session"
}

/** Browse memory files: list + preview; session logs may be deleted (with confirmation). */
export function MemoryModal(props: { onClose?: () => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  const [files, setFiles] = createSignal<MemoryFileEntry[]>([])
  const [selected, setSelected] = createSignal(0)
  const [preview, setPreview] = createSignal("")
  const [error, setError] = createSignal("")

  const load = async () => {
    console.log("MEMORY-MODAL load called")
    try {
      const response = await sdk.client.experimental.memory.list()
      console.log("MEMORY-MODAL list resolved", response.data?.length)
      const list = response.data ?? []
      setFiles(list)
      setSelected(0)
      if (list.length > 0) await previewFile(list[0]!.path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  void load()

  const previewFile = async (path: string) => {
    try {
      const response = await sdk.client.experimental.memory.read({ path })
      const data = response.data
      if (data) setPreview(data.truncated ? `${data.content}\n… (truncated)` : data.content)
    } catch {
      setPreview("(unable to read)")
    }
  }

  const select = async (index: number) => {
    setSelected(index)
    const file = files()[index]
    if (file) await previewFile(file.path)
  }

  const removeSelected = async () => {
    const file = files()[selected()]
    if (!file || !file.path.startsWith("sessions/")) return
    const ok = await DialogConfirm.show(dialog, "Delete session log", `Delete ${file.path}?`)
    if (ok !== true) return
    try {
      await sdk.client.experimental.memory.removeSessionLog({ path: file.path })
      await load()
    } catch {
      setError("Failed to delete session log")
    }
  }

  useBindings(() => ({
    bindings: [
      {
        key: "esc",
        desc: "Close memory browser",
        group: "Memory",
        cmd: () => {
          props.onClose?.()
          dialog.clear()
        },
      },
      {
        key: "up",
        desc: "Previous file",
        group: "Memory",
        cmd: () => {
          if (files().length === 0) return
          void select((selected() - 1 + files().length) % files().length)
        },
      },
      {
        key: "down",
        desc: "Next file",
        group: "Memory",
        cmd: () => {
          if (files().length === 0) return
          void select((selected() + 1) % files().length)
        },
      },
      {
        key: "d",
        desc: "Delete session log",
        group: "Memory",
        cmd: () => void removeSelected(),
      },
    ],
  }))

  const kindLabel = (kind: MemoryFileEntry["kind"]) =>
    kind === "session" ? "session" : kind === "workspace" ? "workspace" : "global"

  const list = createMemo(() =>
    files().map((file, index) => ({
      ...file,
      active: index === selected(),
      label: `${index === selected() ? "› " : "  "}[${kindLabel(file.kind)}] ${file.path}`,
    })),
  )

  return (
    <box width="100%" height="100%" paddingLeft={1} paddingRight={1} paddingTop={1}>
      <box width="100%" height={1}>
        <text style={{ fg: theme.text }} attributes={TextAttributes.BOLD}>Memory</text>
      </box>
      <box width="50%" height="70%">
        <text style={{ fg: theme.text, bg: theme.backgroundPanel }}>
          {error() || list().slice(0, 40).map((item) => item.label).join("\n")}
        </text>
      </box>
      <box width="50%" height="70%" left="50%">
        <text style={{ fg: theme.text, bg: theme.backgroundPanel }}>{preview().slice(0, 4000)}</text>
      </box>
      <box width="100%" height={1} bottom={0}>
        <text style={{ fg: theme.textMuted }}>
          ↑/↓ select · d delete session log · esc close
        </text>
      </box>
    </box>
  )
}
