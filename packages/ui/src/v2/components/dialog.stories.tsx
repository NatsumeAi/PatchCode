import { Dialog as KobalteDialog } from "@kobalte/core/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, DialogTitleGroup } from "./dialog"
import { Button } from "./button"

const docs = `### Overview
Dialog content wrapper built on Kobalte's dialog primitive with kit styling.

Compose with \`DialogHeader\`, \`DialogTitle\`, \`DialogTitleGroup\`, \`DialogBody\`, and \`DialogFooter\`.

### API
- \`Dialog\`: \`size\` (normal | large | x-large), \`variant\`, \`fit\`.
- \`DialogHeader\`: row container with optional \`closeLabel\` and \`hideClose\`.
- \`DialogTitle\`: accessible single-line header title.
- \`DialogTitleGroup\`: column with \`title\` and required \`description\`.

### Accessibility
- Focus trapping and aria attributes provided by Kobalte Dialog.

### Theming/tokens
- Uses \`data-component="dialog"\` and slot attributes.
`

export default {
  title: "UI V2/Dialog",
  id: "components-dialog-kit",
  component: Dialog,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

function dialogHeader(title: string, description: string) {
  return (
    <DialogHeader>
      <DialogTitleGroup title={title} description={description} />
    </DialogHeader>
  )
}

export const Basic = {
  render: () => (
    <KobalteDialog defaultOpen>
      <KobalteDialog.Trigger as={Button} variant="neutral">
        Open dialog
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog>
          {dialogHeader("Dialog", "Description")}
          <DialogBody>Dialog body content.</DialogBody>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
  ),
}

export const Sizes = {
  render: () => (
    <div style={{ display: "flex", gap: "12px" }}>
      <KobalteDialog>
        <KobalteDialog.Trigger as={Button} variant="neutral">
          Normal
        </KobalteDialog.Trigger>
        <KobalteDialog.Portal>
          <KobalteDialog.Overlay />
          <Dialog>
            {dialogHeader("Normal", "Normal size")}
            <DialogBody>Normal dialog content.</DialogBody>
          </Dialog>
        </KobalteDialog.Portal>
      </KobalteDialog>

      <KobalteDialog>
        <KobalteDialog.Trigger as={Button} variant="neutral">
          Large
        </KobalteDialog.Trigger>
        <KobalteDialog.Portal>
          <KobalteDialog.Overlay />
          <Dialog size="large">
            {dialogHeader("Large", "Large size")}
            <DialogBody>Large dialog content.</DialogBody>
          </Dialog>
        </KobalteDialog.Portal>
      </KobalteDialog>

      <KobalteDialog>
        <KobalteDialog.Trigger as={Button} variant="neutral">
          X-Large
        </KobalteDialog.Trigger>
        <KobalteDialog.Portal>
          <KobalteDialog.Overlay />
          <Dialog size="x-large">
            {dialogHeader("Extra large", "X-large size")}
            <DialogBody>X-large dialog content.</DialogBody>
          </Dialog>
        </KobalteDialog.Portal>
      </KobalteDialog>
    </div>
  ),
}

export const TitleOnly = {
  render: () => (
    <KobalteDialog defaultOpen>
      <KobalteDialog.Trigger as={Button} variant="neutral">
        Open dialog
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog>
          <DialogHeader>
            <DialogTitle>Open project</DialogTitle>
          </DialogHeader>
          <DialogBody>Dialog body content.</DialogBody>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
  ),
}

export const HeaderControls = {
  render: () => (
    <KobalteDialog>
      <KobalteDialog.Trigger as={Button} variant="neutral">
        Open dialog
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog>
          <DialogHeader>
            <DialogTitleGroup title="Custom header" description="Dialog with an extra header control" />
            <Button variant="neutral" size="small">
              Help
            </Button>
          </DialogHeader>
          <DialogBody>Dialog body content.</DialogBody>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
  ),
}

export const WithFooter = {
  render: () => (
    <KobalteDialog defaultOpen>
      <KobalteDialog.Trigger as={Button} variant="neutral">
        Open dialog
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog fit>
          {dialogHeader("Save changes", "Your changes will be lost if you don't save them.")}
          <DialogFooter>
            <Button variant="neutral">Cancel</Button>
            <Button variant="contrast">Save</Button>
          </DialogFooter>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
  ),
}

export const WithFooterThreeButtons = {
  render: () => (
    <KobalteDialog defaultOpen>
      <KobalteDialog.Trigger as={Button} variant="neutral">
        Open dialog
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog fit>
          {dialogHeader("Unsaved changes", "You have unsaved changes. What would you like to do?")}
          <DialogFooter>
            <span style={{ "margin-right": "auto" }}>
              <Button variant="ghost">Remind me later</Button>
            </span>
            <Button variant="neutral">Cancel</Button>
            <Button variant="contrast">Save</Button>
          </DialogFooter>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
  ),
}

export const Fit = {
  render: () => (
    <KobalteDialog>
      <KobalteDialog.Trigger as={Button} variant="neutral">
        Open fit dialog
      </KobalteDialog.Trigger>
      <KobalteDialog.Portal>
        <KobalteDialog.Overlay />
        <Dialog fit>
          {dialogHeader("Fit content", "Dialog fits its content.")}
          <DialogBody>Dialog fits its content.</DialogBody>
        </Dialog>
      </KobalteDialog.Portal>
    </KobalteDialog>
  ),
}
