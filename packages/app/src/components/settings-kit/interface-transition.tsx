import { Tag } from "@opencode-ai/ui/kit/badge"
import { Button } from "@opencode-ai/ui/kit/button"
import { Switch } from "@opencode-ai/ui/kit/switch"
import { SettingsList } from "./parts/list"
import { SettingsRow } from "./parts/row"

export function LayoutTransitionToggle(props: {
  title: string
  badge: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div class="settings-kit-section">
      <div class="settings-kit-interface-feature">
        <SettingsList>
          <SettingsRow
            title={
              <span class="flex items-center gap-2">
                {props.title}
                <Tag variant="accent">{props.badge}</Tag>
              </span>
            }
            description={props.description}
          >
            <div data-action="settings-new-layout-designs">
              <Switch checked={props.checked} onChange={props.onChange} />
            </div>
          </SettingsRow>
        </SettingsList>
      </div>
    </div>
  )
}

export function LayoutRetirementNotice(props: {
  title: string
  description: string
  dismiss: string
  onDismiss: () => void
}) {
  return (
    <div class="settings-kit-section">
      <SettingsList>
        <SettingsRow title={props.title} description={props.description}>
          <Button size="small" variant="ghost-muted" onClick={props.onDismiss}>
            {props.dismiss}
          </Button>
        </SettingsRow>
      </SettingsList>
    </div>
  )
}
