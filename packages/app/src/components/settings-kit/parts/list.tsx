import type { Component, JSX } from "solid-js"
import "../settings.css"

export const SettingsList: Component<{ children: JSX.Element }> = (props) => {
  return <div data-component="settings-kit-list">{props.children}</div>
}
