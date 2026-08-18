// @ts-nocheck
import { createSignal } from "solid-js"
import { Checkbox } from "./checkbox"

const docs = `### Overview
Binary and tri-state checkbox using Kobalte Checkbox.

### API
- Forwards Kobalte Checkbox props (\`checked\`, \`defaultChecked\`, \`onChange\`, \`indeterminate\`, \`name\`, \`required\`, \`validationState\`, \`disabled\`, etc.).
- Adds \`label\`, optional \`description\`, and \`hideLabel\`.

### Behavior
- Controlled or uncontrolled via \`checked\` / \`defaultChecked\`.
- Indeterminate is driven by the \`indeterminate\` prop (pass a reactive boolean, e.g. \`indeterminate={flag()}\`).

### Theming/tokens
- Uses \`data-slot="checkbox"\` and slot attributes aligned with radio item layout.
`

export default {
  title: "UI V2/Checkbox",
  id: "components-checkbox-kit",
  component: Checkbox,
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
  render: () => (
    <Checkbox defaultChecked={false} name="terms" label="Accept terms" description="You must accept to continue." />
  ),
}

export const Controlled = {
  render: () => {
    const [checked, setChecked] = createSignal(false)
    return (
      <div style={{ display: "grid", gap: "12px" }}>
        <Checkbox
          name="controlled"
          checked={checked()}
          onChange={setChecked}
          label="Controlled checkbox"
          description="Toggled from Storybook state."
        />
        <div style={{ "font-family": "var(--kit-font-family-sans)", "font-size": "12px", color: "#808080" }}>
          Checked: {String(checked())}
        </div>
      </div>
    )
  },
}

export const Indeterminate = {
  render: () => {
    const [indeterminate, setIndeterminate] = createSignal(true)
    const [checked, setChecked] = createSignal(false)
    return (
      <Checkbox
        name="indeterminate-demo"
        checked={checked()}
        indeterminate={indeterminate()}
        onChange={(v) => {
          setChecked(v)
          if (v) setIndeterminate(false)
        }}
        label="Select all"
        description="Starts indeterminate; checking clears mixed state."
      />
    )
  },
}

export const States = {
  render: () => (
    <div style={{ display: "grid", gap: "20px" }}>
      <Checkbox name="s1" label="Default" description="Helper text." />
      <Checkbox name="s2" defaultChecked label="Checked" />
      <Checkbox name="s3" indeterminate label="Indeterminate" />
      <Checkbox name="s4" disabled label="Disabled" />
      <Checkbox name="s5" disabled defaultChecked label="Checked disabled" />
      <Checkbox name="s6" disabled indeterminate label="Indeterminate disabled" />
      <Checkbox name="s7" label="Invalid" description="Must be checked." required validationState="invalid" />
    </div>
  ),
}
