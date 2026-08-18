import { RadioGroup as Kobalte } from "@kobalte/core/radio-group"
import { Show, splitProps, type JSX } from "solid-js"
import type { ComponentProps, ParentProps } from "solid-js"
import "./radio.css"

export interface RadioGroupProps extends ParentProps<ComponentProps<typeof Kobalte>> {
  label?: JSX.Element
  description?: JSX.Element
  hideLabel?: boolean
}

export function RadioGroup(props: RadioGroupProps) {
  const [local, others] = splitProps(props, ["class", "classList", "children", "label", "description", "hideLabel"])
  return (
    <Kobalte
      {...others}
      data-component="radio"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Show when={local.label}>
        {(label) => (
          <Kobalte.Label data-slot="radio-kit-label" classList={{ "sr-only": local.hideLabel }}>
            {label()}
          </Kobalte.Label>
        )}
      </Show>
      <Show when={local.description}>
        {(description) => <Kobalte.Description data-slot="radio-kit-description">{description()}</Kobalte.Description>}
      </Show>
      <div data-slot="radio-kit-items">{local.children}</div>
      <Kobalte.ErrorMessage data-slot="radio-kit-error" />
    </Kobalte>
  )
}

export interface RadioItemProps extends ComponentProps<typeof Kobalte.Item> {
  label: JSX.Element
  description?: JSX.Element
  hideLabel?: boolean
}

export function RadioItem(props: RadioItemProps) {
  const [local, others] = splitProps(props, ["class", "classList", "label", "description", "hideLabel"])
  return (
    <Kobalte.Item
      {...others}
      data-slot="radio-kit-item"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Kobalte.ItemInput data-slot="radio-kit-item-input" />
      <div data-slot="radio-kit-item-control-stack">
        <Kobalte.ItemControl data-slot="radio-kit-item-control">
          <Kobalte.ItemIndicator data-slot="radio-kit-item-indicator" />
        </Kobalte.ItemControl>
      </div>
      <Kobalte.ItemLabel data-slot="radio-kit-item-label" classList={{ "sr-only": local.hideLabel }}>
        <div data-slot="radio-kit-item-text">
          <span data-slot="radio-kit-item-label-text">{local.label}</span>
          <Show when={local.description}>
            {(description) => <span data-slot="radio-kit-item-description">{description()}</span>}
          </Show>
        </div>
      </Kobalte.ItemLabel>
    </Kobalte.Item>
  )
}
