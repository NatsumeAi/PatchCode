// @ts-nocheck
import { createSignal } from "solid-js"
import { Field } from "./field"
import { InlineInput } from "./inline-input"

const docs = `### Overview
Single-line field with an inline prefix label, vertical divider, and the same states as kit TextInput.

### API
- \`prefix\`: Inline label in the leading segment (required).
- \`labelWidth\`: Fixed prefix width (px number or CSS length). Omit for fit-content.
- Forwards native \`input\` props (\`value\`, \`defaultValue\`, \`placeholder\`, \`disabled\`, etc.).
- \`showCopyButton\`, \`copyLabel\`, \`onCopyClick\`: Optional trailing copy control.
- \`invalid\`: Error outline and danger text color.
- \`appearance\`: \`"base"\` (28px) or \`"large"\` (32px).
- \`numeric\`: Tabular numerals on prefix and value.

### States
- **Hover**, **Focus**, **Invalid**, **Disabled** — same as kit TextInput on the outer shell.

### Field
Compose with \`Field\` for label, helper prefix/suffix, and tooltip — see the **Field** story.
`

export default {
  title: "UI V2/InlineInput",
  id: "components-inline-input-kit",
  component: InlineInput,
  tags: ["autodocs"],
  parameters: {
    frameHeight: "400px",
    frameBackground: "#fff",
    docs: {
      description: {
        component: docs,
      },
    },
  },
  args: {
    prefix: "Label",
    placeholder: "Text",
    showCopyButton: true,
    disabled: false,
    invalid: false,
    appearance: "base",
  },
  argTypes: {
    prefix: {
      control: "text",
    },
    labelWidth: {
      control: "number",
    },
    appearance: {
      control: "select",
      options: ["base", "large"],
    },
    showCopyButton: {
      control: "boolean",
    },
    disabled: {
      control: "boolean",
    },
    invalid: {
      control: "boolean",
    },
    placeholder: {
      control: "text",
    },
  },
}

export const Playground = {}

export const Controlled = {
  render: () => {
    const [value, setValue] = createSignal("42")
    return (
      <div style={{ display: "grid", gap: "12px", width: "280px" }}>
        <InlineInput
          prefix="Amount"
          value={value()}
          onInput={(e) => setValue(e.currentTarget.value)}
          placeholder="0.00"
          numeric
        />
        <div
          style={{
            "font-family": "var(--kit-font-family-sans)",
            "font-size": "12px",
            color: "var(--text-text-faint)",
          }}
        >
          Value: {value()}
        </div>
      </div>
    )
  },
}

export const Appearances = {
  render: () => (
    <div style={{ display: "grid", gap: "20px", width: "280px" }}>
      <InlineInput prefix="Label" appearance="base" placeholder="Text" showCopyButton />
      <InlineInput prefix="Label" appearance="large" placeholder="Text" showCopyButton />
      <InlineInput prefix="Label" labelWidth={50} placeholder="Text" showCopyButton />
      <InlineInput prefix="Long label" placeholder="Text" showCopyButton />
    </div>
  ),
}

export const Field = {
  parameters: { frameHeight: "500px" },
  render: () => (
    <div style={{ display: "grid", gap: "24px", width: "280px" }}>
      <Field>
        <Field.Label tooltip="Additional context">Label</Field.Label>
        <Field.Prefix>Prefix</Field.Prefix>
        <InlineInput prefix="USD" placeholder="0.00" numeric showCopyButton />
        <Field.Suffix>Suffix</Field.Suffix>
      </Field>
      <Field invalid>
        <Field.Label>Label</Field.Label>
        <Field.Prefix>Prefix</Field.Prefix>
        <InlineInput prefix="USD" placeholder="0.00" defaultValue="Invalid" showCopyButton />
        <Field.Suffix>Suffix</Field.Suffix>
      </Field>
    </div>
  ),
}

export const States = {
  render: () => (
    <div style={{ display: "grid", gap: "20px", width: "280px" }}>
      <InlineInput prefix="Label" placeholder="Text" showCopyButton />
      <InlineInput prefix="Label" placeholder="Text" defaultValue="Hello" showCopyButton />
      <InlineInput prefix="Label" placeholder="Text" defaultValue="Invalid" invalid showCopyButton />
      <InlineInput prefix="Label" placeholder="Text" disabled showCopyButton />
    </div>
  ),
}
