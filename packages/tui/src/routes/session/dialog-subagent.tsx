import { DialogSelect } from "../../ui/dialog-select"
import { useRoute } from "../../context/route"
import type { DialogContext } from "../../ui/dialog"

export type SubagentListItem = {
  id: string
  title: string
  agent?: string
  busy?: boolean
}

/** Picker for navigating into child (subagent) sessions. */
export function DialogSubagentList(props: { sessions: ReadonlyArray<SubagentListItem> }) {
  const route = useRoute()

  return (
    <DialogSelect
      title="Subagents"
      options={props.sessions.map((item) => ({
        title: item.agent ?? "subagent",
        value: item.id,
        description: `${item.busy ? "busy · " : ""}${item.title}`,
        onSelect: (dialog: DialogContext) => {
          route.navigate({
            type: "session",
            sessionID: item.id,
          })
          dialog.clear()
        },
      }))}
    />
  )
}

/** @deprecated Prefer DialogSubagentList with an explicit sessions array. */
export function DialogSubagent(props: { sessionID: string }) {
  return <DialogSubagentList sessions={[{ id: props.sessionID, title: props.sessionID }]} />
}
