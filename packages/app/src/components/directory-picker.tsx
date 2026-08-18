import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ServerConnection } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { lazy } from "solid-js"
import { DialogSelectDirectory } from "./dialog-select-directory"
import { directoryPickerKind } from "./directory-picker-policy"

const DialogSelectDirectoryKit = lazy(() =>
  import("./dialog-select-directory-kit").then((module) => ({ default: module.DialogSelectDirectory })),
)

type DirectoryPickerInput = {
  server: ServerConnection.Any
  title?: string
  multiple?: boolean
  onSelect: (result: string | string[] | null) => void
}

export function useDirectoryPicker() {
  const platform = usePlatform()
  const settings = useSettings()
  const dialog = useDialog()

  return (input: DirectoryPickerInput) => {
    if (directoryPickerKind(platform.platform, input.server) === "native" && platform.platform === "desktop") {
      void platform.openDirectoryPickerDialog({ title: input.title, multiple: input.multiple }).then(input.onSelect)
      return
    }

    let selected = false
    const onSelect = (result: string | string[] | null) => {
      selected = result !== null
      input.onSelect(result)
    }
    const cancel = () => {
      if (!selected) input.onSelect(null)
    }
    if (platform.platform === "desktop" && settings.general.newLayoutDesigns()) {
      dialog.show(() => <DialogSelectDirectoryKit {...input} onSelect={onSelect} />, cancel)
      return
    }
    dialog.show(() => <DialogSelectDirectory {...input} onSelect={onSelect} />, cancel)
  }
}
