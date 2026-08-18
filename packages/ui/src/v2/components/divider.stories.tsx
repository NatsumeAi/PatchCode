import { Divider } from "./divider"

const docs = `### Overview
Horizontal hairline divider for kit layouts.

### API
- Inherits native div attributes.
- Stretches to full width of its flex parent.

### Theming/tokens
- Uses \`data-component="divider"\`.
- Border color: \`--kit-border-border-strong\`.
`

export default {
  title: "UI V2/Divider",
  id: "components-divider-kit",
  component: Divider,
  tags: ["autodocs"],
  parameters: {
    frameWidth: "320px",
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = {
  render: () => (
    <div style={{ display: "flex", "flex-direction": "column", gap: "16px", padding: "16px" }}>
      <span>Above</span>
      <Divider />
      <span>Below</span>
    </div>
  ),
}
