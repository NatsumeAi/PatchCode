import { type ComponentProps, For, splitProps } from "solid-js"
import "./keybind.css"

export interface KeybindProps extends ComponentProps<"div"> {
  keys: string[]
  variant?: "neutral" | "ghost"
}

export function Keybind(props: KeybindProps) {
  const [local, rest] = splitProps(props, ["keys", "variant", "class", "classList"])
  return (
    <div
      {...rest}
      data-component="keybind"
      data-variant={local.variant || "neutral"}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <For each={local.keys}>
        {(key) => (
          <div data-slot="keybind-kit-key">
            <span data-slot="keybind-kit-label">{key}</span>
          </div>
        )}
      </For>
    </div>
  )
}
