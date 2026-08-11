import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal } from "solid-js"
import { useDialog } from "./ui/dialog"
import { DialogConfirm } from "./ui/dialog-confirm"
import { DialogPrompt } from "./ui/dialog-prompt"
import { DialogSelect } from "./ui/dialog-select"
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
      const h = health.data as
        | {
            files: number
            chunks: number
            bySource: { global: number; workspace: number; session: number }
            zeroAccessChunks: number
            pruneCandidates: number
            lastConsolidateStatus?: string
            lastConsolidateReason?: string
            hybridEnabled?: boolean
            hybridModel?: string
            vectorCoverage?: number
            actionHint?: string
          }
        | undefined
      if (h) {
        const consolidate =
          h.lastConsolidateStatus !== undefined
            ? ` · last consolidate: ${h.lastConsolidateStatus}${h.lastConsolidateReason ? ` (${h.lastConsolidateReason})` : ""}`
            : ""
        const hybrid =
          h.hybridEnabled === true
            ? ` · hybrid ${h.hybridModel ?? "on"} vectors ${Math.round((h.vectorCoverage ?? 0) * 100)}%`
            : " · hybrid off"
        const hint = h.actionHint ? ` · ⚠ ${h.actionHint}` : ""
        setStats(
          `files ${h.files} · chunks ${h.chunks} (g${h.bySource.global}/w${h.bySource.workspace}/s${h.bySource.session}) · zero-access ${h.zeroAccessChunks} · prune candidates ${h.pruneCandidates}${consolidate}${hybrid}${hint}`,
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

  const runImport = (source: string, force: boolean) => {
    void sdk.client.experimental.memory
      .importPack({ source, force })
      .then((response) => {
        const result = response.data
        if (result?.error) {
          toast.show({
            message: force
              ? `Import failed: ${result.error}`
              : `Import failed: ${result.error}. Re-run import and choose force overwrite if local files are newer.`,
            variant: "error",
          })
        } else if (result) {
          const detail =
            result.skipped > 0
              ? `Imported ${result.imported}, skipped ${result.skipped} (newer local or threats).${force ? "" : " Use force overwrite to replace newer locals."}`
              : `Imported ${result.imported} file(s)${force ? " (force)" : ""}.`
          toast.show({ message: detail, variant: "success" })
          void load()
        }
      })
      .catch((cause) =>
        toast.show({
          message: `Import failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          variant: "error",
        }),
      )
  }

  const runHistoryImport = (source: string) => {
    void sdk.client.experimental.memory
      .importHistory({ source, format: "auto" })
      .then((response) => {
        const result = response.data
        if (result?.error) {
          toast.show({ message: `Import failed: ${result.error}`, variant: "error" })
        } else if (result) {
          // This route imports either chat messages (jsonl/messages-json) or an
          // already memory-shaped directory pack (files), so the wording is
          // deliberately generic.
          const detail =
            result.skipped > 0
              ? `Imported ${result.imported} item(s), skipped ${result.skipped} (threats, roles, or newer locals).`
              : `Imported ${result.imported} item(s).`
          toast.show({ message: detail, variant: "success" })
          void load()
        }
      })
      .catch((cause) =>
        toast.show({
          message: `Import failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          variant: "error",
        }),
      )
  }

  const importPack = async () => {
    dialog.replace(() => (
      <DialogPrompt
        title="Import memory pack"
        placeholder="absolute path to pack dir (export created this)"
        onConfirm={(path) => {
          const trimmed = path.trim()
          if (!trimmed) {
            toast.show({ message: "Import path required", variant: "error" })
            return
          }
          // Mode select: skip-newer (default) vs force overwrite vs external history import.
          dialog.replace(() => (
            <DialogSelect
              title="Import mode"
              options={[
                {
                  value: "skip",
                  title: "Skip newer local files",
                  description: "Safe default — never overwrite newer-or-equal curated files",
                },
                {
                  value: "force",
                  title: "Force overwrite",
                  description: "Overwrite local curated files even if newer than pack",
                },
                {
                  value: "history",
                  title: "Import external history",
                  description: "Chat export (jsonl / messages-json), format auto-detected",
                },
              ]}
              onSelect={(option) => {
                if (option.value === "history") runHistoryImport(trimmed)
                else runImport(trimmed, option.value === "force")
                dialog.clear()
              }}
            />
          ))
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
          ↑/↓ select · d delete session log · e export · i import (skip/force/history) · esc close
        </text>
      </box>
      <box width="100%" height={1} bottom={0}>
        <text style={{ fg: theme.textMuted }}>{stats()}</text>
      </box>
    </box>
  )
}
