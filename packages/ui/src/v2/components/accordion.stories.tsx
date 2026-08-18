// @ts-nocheck
import { Accordion } from "./accordion"

const docs = `### Overview
Compound accordion built on Kobalte's \`Accordion\` primitive. The trigger automatically renders a chevron that rotates open.

### API
- \`Accordion\` — root; forwards Kobalte props (\`multiple\`, \`collapsible\`, \`value\`, \`defaultValue\`, \`onChange\`, etc.).
- \`Accordion.Item\` — one expandable row; requires a unique \`value: string\`.
- \`Accordion.Header\` — wraps the trigger; preserves heading semantics.
- \`Accordion.Trigger\` — auto-renders a trailing chevron; pass \`hideChevron\` to opt out.
- \`Accordion.Content\` — body shown when the item is expanded; height-animated.

### Behavior
- Single-select by default (\`collapsible\` allows closing the active item). Use \`multiple\` to let several items open at once.
- Open/closed state is reflected on items, triggers, and content via \`data-expanded\` / \`data-closed\`.
- Content height animates using Kobalte's \`--kb-collapsible-content-height\` variable.
`

export default {
  title: "UI V2/Accordion",
  id: "components-accordion-kit",
  component: Accordion,
  tags: ["autodocs"],
  parameters: {
    frameBackground: "#f5f5f5",
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

const frame = { width: "346px", "font-family": "var(--kit-font-family-sans)", "font-size": "13px" } as const

export const Basic = {
  render: () => (
    <div style={frame}>
      <Accordion collapsible defaultValue={["item-1"]}>
        <Accordion.Item value="item-1">
          <Accordion.Header>
            <Accordion.Trigger>Is it accessible?</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>
            Yes. It follows the WAI-ARIA Accordion pattern and ships with full keyboard support.
          </Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="item-2">
          <Accordion.Header>
            <Accordion.Trigger>Is it styled?</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>Yeah</Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="item-3">
          <Accordion.Header>
            <Accordion.Trigger>Is it animated?</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>Yes. Height animates via Kobalte's collapsible height variable.</Accordion.Content>
        </Accordion.Item>
      </Accordion>
    </div>
  ),
}

export const Multiple = {
  render: () => (
    <div style={frame}>
      <Accordion multiple defaultValue={["a", "c"]}>
        <Accordion.Item value="a">
          <Accordion.Header>
            <Accordion.Trigger>Section A</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>Multiple items can be open at once.</Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="b">
          <Accordion.Header>
            <Accordion.Trigger>Section B</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>Open me too.</Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="c">
          <Accordion.Header>
            <Accordion.Trigger>Section C</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>Already open by default.</Accordion.Content>
        </Accordion.Item>
      </Accordion>
    </div>
  ),
}

export const Disabled = {
  render: () => (
    <div style={frame}>
      <Accordion collapsible>
        <Accordion.Item value="one">
          <Accordion.Header>
            <Accordion.Trigger>Enabled item</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>Body content.</Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="two" disabled>
          <Accordion.Header>
            <Accordion.Trigger>Disabled item</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>You can't open this one.</Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="three">
          <Accordion.Header>
            <Accordion.Trigger>Another enabled item</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>Body content.</Accordion.Content>
        </Accordion.Item>
      </Accordion>
    </div>
  ),
}

export const LongContent = {
  render: () => (
    <div style={frame}>
      <Accordion collapsible defaultValue={["long"]}>
        <Accordion.Item value="long">
          <Accordion.Header>
            <Accordion.Trigger>What's inside?</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>
            <div style={{ display: "grid", gap: "8px" }}>
              <p style={{ margin: 0 }}>
                Accordions are useful for compressing dense content into scannable sections. They preserve heading
                semantics and announce open/closed state to screen readers.
              </p>
              <p style={{ margin: 0 }}>
                The body can hold arbitrary content — paragraphs, lists, even nested components.
              </p>
              <ul style={{ margin: 0, "padding-left": "16px" }}>
                <li>Keyboard navigable</li>
                <li>Animated</li>
                <li>Themeable via CSS variables</li>
              </ul>
            </div>
          </Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="short">
          <Accordion.Header>
            <Accordion.Trigger>One more</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>Short body.</Accordion.Content>
        </Accordion.Item>
      </Accordion>
    </div>
  ),
}

export const NoChevron = {
  render: () => (
    <div style={frame}>
      <Accordion collapsible>
        <Accordion.Item value="x">
          <Accordion.Header>
            <Accordion.Trigger hideChevron>Trigger without chevron</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>
            Pass <code>hideChevron</code> on the trigger.
          </Accordion.Content>
        </Accordion.Item>
        <Accordion.Item value="y">
          <Accordion.Header>
            <Accordion.Trigger>Default trigger</Accordion.Trigger>
          </Accordion.Header>
          <Accordion.Content>Chevron renders by default.</Accordion.Content>
        </Accordion.Item>
      </Accordion>
    </div>
  ),
}
