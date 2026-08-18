import type { Component, JSX } from "solid-js"
import "../settings.css"

export interface SettingsRowProps {
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}

export const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div data-component="settings-kit-row">
      <div data-slot="settings-kit-row-copy">
        <div data-slot="settings-kit-row-title">{props.title}</div>
        <div data-slot="settings-kit-row-description">{props.description}</div>
      </div>
      <div data-slot="settings-kit-row-control">{props.children}</div>
    </div>
  )
}
