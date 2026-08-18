import { Show, type JSX, type ParentProps } from "solid-js"
import "./session-review.css"

export function SessionFilePanel(props: {
  sidebar?: JSX.Element
  toolbar: boolean
  toolbarStart?: JSX.Element
  toolbarEnd?: JSX.Element
  children?: JSX.Element
}) {
  return (
    <div data-component="session-review">
      <div data-slot="session-review-kit-body">
        {props.sidebar}
        <div data-slot="session-review-kit-preview">
          <Show when={props.toolbar}>
            <div data-slot="session-review-kit-toolbar">
              <div data-slot="session-review-kit-toolbar-group" class="session-review-kit-toolbar-group--start">
                {props.toolbarStart}
              </div>
              <Show when={props.toolbarEnd}>
                {(toolbar) => (
                  <div data-slot="session-review-kit-toolbar-group" class="session-review-kit-toolbar-group--segments">
                    {toolbar()}
                  </div>
                )}
              </Show>
            </div>
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  )
}

export function SessionFilePanelTitle(props: ParentProps) {
  return <div data-slot="session-review-kit-toolbar-title">{props.children}</div>
}

export function SessionFilePanelEmpty(props: ParentProps) {
  return <div data-slot="session-review-kit-empty">{props.children}</div>
}
