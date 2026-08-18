import { createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/kit/button"
import { ToolErrorCard, type ToolErrorCardProps } from "./tool-error-card"

const docs = `### Overview
Compact tool error row with optional expandable detail, aligned to the OpenCode design system spec.

### API
- \`ToolErrorCard\` wraps Kobalte \`Collapsible\` directly. Pass \`open\`, \`defaultOpen\`, and \`onOpenChange\` like any disclosure (controlled when \`open\` is defined).
- Without a non-empty \`suffix\`, the card is not expandable (\`disabled\` on the collapsible root).

### Theming
- Uses \`data-component="tool-error-card"\` and slot attributes; colors are CSS variables on the root (\`--tec-*\`).
`

export default {
  title: "UI V2/ToolErrorCard",
  id: "components-tool-error-card-kit",
  component: ToolErrorCard,
  tags: ["autodocs"],
  parameters: {
    frameBackground: "#fff",
    layout: "padded",
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Default = {
  args: {
    title: "Read",
    subtitle: "Permission denied",
    suffix: "The tool could not access the requested path.",
    defaultOpen: false,
  } satisfies ToolErrorCardProps,
  render: (args: ToolErrorCardProps) => <ToolErrorCard {...args} />,
}

export const Loading = {
  args: {
    title: "Read",
    subtitle: "Working",
    suffix: "Details appear when the tool finishes.",
    loading: true,
    defaultOpen: false,
  } satisfies ToolErrorCardProps,
  render: (args: ToolErrorCardProps) => <ToolErrorCard {...args} />,
}

export const SubtitleLink = {
  args: {
    title: "Task",
    subtitle: "View logs",
    subtitleHref: "https://example.com",
    suffix: "Subagent exited with code 1.",
    defaultOpen: false,
  } satisfies ToolErrorCardProps,
  render: (args: ToolErrorCardProps) => <ToolErrorCard {...args} />,
}

export const NoSuffixDisabled = {
  args: {
    title: "List",
    subtitle: "No detail",
    defaultOpen: false,
  } satisfies ToolErrorCardProps,
  render: (args: ToolErrorCardProps) => <ToolErrorCard {...args} />,
}

export const Controlled = {
  render: () => {
    const [open, setOpen] = createSignal(false)
    return (
      <div style={{ display: "flex", "flex-direction": "column", gap: "24px", "max-width": "420px" }}>
        <Button type="button" classList={{ "w-fit": true }} onClick={() => setOpen((o) => !o)}>
          Toggle from outside: {open() ? "Open" : "Closed"}
        </Button>
        <ToolErrorCard
          title="Grep"
          subtitle="Timeout"
          suffix="Operation exceeded 30s."
          open={open()}
          onOpenChange={setOpen}
        />
      </div>
    )
  },
}
