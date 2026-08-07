import { DialogPrompt } from "./ui/dialog-prompt"
import { useDialog } from "./ui/dialog"
import { useSDK } from "./context/sdk"
import { useToast } from "./ui/toast"

/**
 * `/remember` UX: the user types the note, confirms, and the request is sent
 * as a session prompt so the agent executes the existing memory_add_note tool.
 * Not a security boundary and not a second write path — the write still goes
 * through the agent's memory_add_note tool (description-gated as in P1).
 */
export function RememberPrompt(props: { sessionID: string; initial?: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  return (
    <DialogPrompt
      title="Remember in memory"
      description={() => (
        <text>
          The agent will save this as an append-only memory note via memory_add_note. Press esc to cancel.
        </text>
      )}
      placeholder="what should be remembered?"
      value={props.initial}
      onConfirm={(note) => {
        const text = note.trim()
        if (text.length === 0) return
        void sdk.client.session
          .prompt({
            sessionID: props.sessionID,
            parts: [
              {
                type: "text",
                text: `Please remember this in memory (use memory_add_note, only after confirming with the user): ${text}`,
              },
            ],
          })
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to send remember request",
              variant: "error",
            })
          })
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
