import { Tooltip } from "./tooltip"
import { Keybind } from "./keybind"

const docs = `### Overview
Floating tooltip built on Kobalte's tooltip primitive with kit styling.

### API
- \`value\`: Content rendered inside the floating tooltip.
- \`children\`: The trigger element that activates the tooltip on hover/focus.
- \`placement\`: Kobalte placement string (e.g. "top", "bottom", "left", "right").
- \`inactive\`: When true, renders only the trigger without tooltip behavior.
- \`forceOpen\`: Forces the tooltip to stay open.
- Inherits Kobalte Tooltip root props.
`

export default {
  title: "UI V2/Tooltip",
  id: "components-tooltip-kit",
  component: Tooltip,
  tags: ["autodocs"],
  parameters: {
    frameHeight: "300px",
    frameBackground: "#fff",
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Simple = {
  render: () => (
    <div style={{ padding: "80px", display: "flex", "justify-content": "center" }}>
      <Tooltip value="Tooltip Text">
        <span>Hover me</span>
      </Tooltip>
    </div>
  ),
}

export const WithKeybind = {
  render: () => (
    <div style={{ padding: "80px", display: "flex", "justify-content": "center" }}>
      <Tooltip
        value={
          <>
            Tooltip Text
            <Keybind keys={["⌘", "⌘"]} variant="neutral" />
          </>
        }
      >
        <span>Hover me</span>
      </Tooltip>
    </div>
  ),
}

export const Path = {
  render: () => (
    <div style={{ padding: "80px", display: "flex", "justify-content": "center" }}>
      <Tooltip
        value={
          <>
            Components <span style={{ color: "var(--text-text-faint)" }}>/</span> Tooltip
          </>
        }
      >
        <span>Hover me</span>
      </Tooltip>
    </div>
  ),
}

export const TitleDescription = {
  render: () => (
    <div style={{ padding: "80px", display: "flex", "justify-content": "center" }}>
      <Tooltip
        value={
          <>
            <span>Title</span>
            <span style={{ color: "var(--text-text-faint)" }}>·</span>
            <span style={{ color: "var(--text-text-faint)" }}>Description</span>
          </>
        }
      >
        <span>Hover me</span>
      </Tooltip>
    </div>
  ),
}
