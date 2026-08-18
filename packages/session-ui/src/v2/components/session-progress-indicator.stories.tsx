// @ts-nocheck
import { SessionProgressIndicator } from "./session-progress-indicator"

const docs = `### Overview
Animated 5×5 dot grid loader for in-progress session state.

Derived from Figma \`_sessionProgressIndicator\` with 8-frame rotation.

### API
- Accepts standard SVG props.

### Behavior
- CSS keyframes drive per-dot opacity across 8 frames (1.2s loop).
- Center dot stays at full opacity throughout the cycle.

### Accessibility
- Sets \`aria-hidden="true"\` by default.

### Theming
- Uses \`currentColor\` via \`--kit-icon-icon-muted\`.
`

export default {
  title: "UI V2/SessionProgressIndicator",
  id: "components-session-progress-indicator-kit",
  component: SessionProgressIndicator,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = {
  render: () => <SessionProgressIndicator />,
}

export const Sizes = {
  render: () => (
    <div style={{ display: "flex", gap: "16px", "align-items": "center" }}>
      <SessionProgressIndicator width={12} height={12} />
      <SessionProgressIndicator />
      <SessionProgressIndicator width={24} height={24} />
    </div>
  ),
}

export const OnDark = {
  render: () => (
    <div
      style={{
        display: "flex",
        gap: "16px",
        "align-items": "center",
        padding: "16px",
        "background-color": "#171717",
        color: "#c7c7c7",
      }}
    >
      <SessionProgressIndicator />
    </div>
  ),
}
