import { For } from "solid-js"
import type { BodyModel } from "@opencode-ai/session-display"
import { useTheme } from "../../context/theme"
import { TodoItem } from "../../component/todo-item"

export function TodosBody(props: { body: Extract<BodyModel, { kind: "todos" }> }) {
  return (
    <box>
      <For each={props.body.items}>
        {(todo) => <TodoItem status={todo.status} content={todo.content} />}
      </For>
    </box>
  )
}
