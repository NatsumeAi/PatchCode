import type { BoxRenderable, ColorInput, MouseEvent } from "@opentui/core"
import { RESIZE_HANDLE_WIDTH } from "../../util/sidebar-layout"

export type SidebarResizeHandleProps = {
  color: ColorInput
  activeColor: ColorInput
  onStart: (event: MouseEvent) => void
  onDrag: (event: MouseEvent) => void
  onEnd: (event: MouseEvent) => void
}

export function SidebarResizeHandle(props: SidebarResizeHandleProps) {
  // Hover and drag state update the border color imperatively instead of
  // through reactive signals: mouse events are handled outside the render
  // loop, and a signal-driven re-render there would rebuild this subtree
  // without the renderer context. The imperative path is identical in the
  // test harness and the live TUI.
  let box: BoxRenderable | undefined
  let dragging = false

  const setVisual = (active: boolean) => {
    if (!box) return
    box.borderColor = active ? props.activeColor : props.color
  }

  const finish = (event: MouseEvent) => {
    event.stopPropagation()
    if (!dragging) return
    dragging = false
    setVisual(false)
    props.onEnd(event)
  }

  return (
    <box
      id="sidebar-resize-handle"
      ref={(node) => {
        box = node
      }}
      width={RESIZE_HANDLE_WIDTH}
      flexShrink={0}
      height="100%"
      border={["left"]}
      borderColor={props.color}
      onMouseOver={() => setVisual(true)}
      onMouseOut={() => {
        if (!dragging) setVisual(false)
      }}
      onMouseDown={(event) => {
        event.stopPropagation()
        event.preventDefault()
        dragging = true
        setVisual(true)
        props.onStart(event)
      }}
      onMouseDrag={(event) => {
        event.stopPropagation()
        if (dragging) props.onDrag(event)
      }}
      onMouseUp={finish}
      onMouseDragEnd={finish}
    />
  )
}
