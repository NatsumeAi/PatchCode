import { DialogPrompt } from "./ui/dialog-prompt"
import { useDialog } from "./ui/dialog"
import { useSDK } from "./context/sdk"
import { useToast } from "./ui/toast"

/**
 * `/remember` UX: the user types the note, confirms, and the note is written
 * directly via POST /experimental/memory/remember (same writeMemoryNote path as
 * memory_add_note). Falls back to a session prompt without double-confirm wording
 * when the remember API is unavailable.
 */
export function RememberPrompt(props: { sessionID: string; initial?: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  const fallbackAgentPrompt = (text: string) => {
    void sdk.client.session
      .prompt({
        sessionID: props.sessionID,
        parts: [
          {
            type: "text",
            text: `Please remember this in memory (use memory_add_note): ${text}`,
          },
        ],
      })
      .then(() => {
        toast.show({ message: "Remember request sent to agent", variant: "info" })
      })
      .catch((error) => {
        toast.show({
          message: error instanceof Error ? error.message : "Failed to send remember request",
          variant: "error",
        })
      })
  }

  const saveDirect = (text: string) => {
    const remember = sdk.client.experimental.memory.remember
    if (typeof remember !== "function") {
      fallbackAgentPrompt(text)
      return
    }
    void remember
      .call(sdk.client.experimental.memory, { note: text })
      .then((response) => {
        const filename = response.data?.filename
        if (filename) {
          toast.show({ message: `Saved memory note ${filename}`, variant: "success" })
          return
        }
        // Missing data often means the route is not deployed yet — fall back.
        if (response.error) {
          fallbackAgentPrompt(text)
          return
        }
        toast.show({ message: "Saved memory note", variant: "success" })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        // 404 / method missing → agent fallback without double-confirm wording
        if (/404|not found|is not a function/i.test(message)) {
          fallbackAgentPrompt(text)
          return
        }
        toast.show({
          message: message || "Failed to save memory note",
          variant: "error",
        })
      })
  }

  return (
    <DialogPrompt
      title="Remember in memory"
      description={() => (
        <text>
          Saves an append-only memory note under extensions/ad_hoc/notes/. Press esc to cancel.
        </text>
      )}
      placeholder="what should be remembered?"
      value={props.initial}
      onConfirm={(note) => {
        const text = note.trim()
        if (text.length === 0) return
        saveDirect(text)
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
