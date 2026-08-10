import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"
import { useDialog } from "./ui/dialog"
import { DialogConfirm } from "./ui/dialog-confirm"
import { DialogPrompt } from "./ui/dialog-prompt"
import { useTheme } from "./context/theme"
import { useSDK } from "./context/sdk"
import { useToast } from "./ui/toast"
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
  const toast = useToast()
  const [files, setFiles] = createSignal<MemoryFileEntry[]>([])
  const [selected, setSelected] = createSignal(0)
  const [preview, setPreview] = createSignal("")
  const [error, setError] = createSignal("")
  const [stats, setStats] = createSignal("")

  const load = async () => {
    try {
      const response = await sdk.client.experimental.memory.list()
      const list = response.data ?? []
      setFiles(list)
      setSelected(0)
      if (list.length > 0) await previewFile(list[0]!.path)
      const health = await sdk.client.experimental.memory.health()
      const h = health.data
      if (h) {
        const consolidate =
          h.lastConsolidateStatus !== undefined
            ? ` · last consolidate: ${h.lastConsolidateStatus}${h.lastConsolidateReason ? ` (${h.lastConsolidateReason})` : ""}`
            : ""
        setStats(
          `files ${h.files} · chunks ${h.chunks} (g${h.bySource.global}/w${h.bySource.workspace}/s${h.bySource.session}) · zero-access ${h.zeroAccessChunks} · prune candidates ${h.pruneCandidates}${consolidate}`,
        )
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const exportPack = async () => {
    dialog.replace(() => (
      <DialogPrompt
        title="Export memory"
        value={`${new Date().toISOString().slice(0, 10)}-memory-pack`}
        onConfirm={(path) => {
          void sdk.client.experimental.memory
            .exportPack({ target: path })
            .then((response) =>
              response.data === true
                ? toast.show({ message: "Memory exported", variant: "success" })
                : toast.show({ message: "Export failed", variant: "error" }),
            )
            .catch(() => toast.show({ message: "Export failed", variant: "error" }))
          dialog.clear()
        }}
        onCancel={() => dialog.clear()}
      />
    ))
  }

  const importPack = async () => {
    dialog.replace(() => (
      <DialogPrompt
        title="Import memory"
        placeholder="path to a memory pack directory"
        onConfirm={(path) => {
          void sdk.client.experimental.memory
            .importPack({ source: path })
            .then((response) => {
              const result = response.data
              if (result?.error) {
                toast.show({ message: `Import failed: ${result.error}`, variant: "error" })
              } else if (result) {
                toast.show({ message: `Imported ${result.imported}, skipped ${result.skipped}`, variant: "success" })
                void load()
              }
            })
            .catch(() => toast.show({ message: "Import failed", variant: "error" }))
          dialog.clear()
        }}
        onCancel={() => dialog.clear()}
      />
    ))
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
      {
        key: "e",
        desc: "Export memory pack",
        group: "Memory",
        cmd: () => void exportPack(),
      },
      {
        key: "i",
        desc: "Import memory pack",
        group: "Memory",
        cmd: () => void importPack(),
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
      <box width="100%" height={1} bottom={1}>
        <text style={{ fg: theme.textMuted }}>
          ↑/↓ select · d delete session log · e export · i import · esc close
        </text>
      </box>
      <box width="100%" height={1} bottom={0}>
        <text style={{ fg: theme.textMuted }}>{stats()}</text>
      </box>
    </box>
  )
}
