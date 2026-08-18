import { For, Show } from "solid-js"
import { Menu } from "@opencode-ai/ui/kit/menu"
import { Tooltip } from "@opencode-ai/ui/kit/tooltip"
import { Icon } from "@opencode-ai/ui/icon"
import { Icon as KitIcon } from "@opencode-ai/ui/kit/icon"
import { getFilename } from "@opencode-ai/core/util/path"
import { useLanguage } from "@/context/language"

export function PromptWorkspaceSelector(props: {
  value: string
  projectRoot: string
  workspaces: string[]
  branch?: string
  onChange: (value: string) => void
  onDone: () => void
}) {
  const language = useLanguage()
  let pending: string | undefined
  const selected = () => (props.value === props.projectRoot ? "main" : props.value)
  const icon = () => {
    if (selected() === "main") return "monitor"
    if (selected() === "create") return "workspace-new"
    return "workspace"
  }
  const select = (value: string) => {
    pending = value
  }
  const onOpenChange = (open: boolean) => {
    if (open) return
    const value = pending
    pending = undefined
    if (value) props.onChange(value)
    props.onDone()
  }
  const label = () => {
    if (selected() === "main") return language.t("session.new.workspace.triggerLocal")
    if (props.value === "create") return language.t("workspace.new")
    return getFilename(props.value)
  }

  return (
    <>
      <span class="hidden select-none opacity-50 sm:inline mx-1">/</span>
      <Menu placement="bottom" gutter={4} onOpenChange={onOpenChange}>
        <Menu.Trigger class="flex h-7 min-w-0 max-w-[203px] items-center gap-1.5 rounded-sm px-1.5 hover:bg-kit-overlay-simple-overlay-hover focus-visible:bg-kit-overlay-simple-overlay-hover focus-visible:outline-none data-[expanded]:bg-kit-overlay-simple-overlay-pressed data-[expanded]:text-kit-text-text-muted">
          <KitIcon name={icon()} class="shrink-0 text-kit-icon-icon-muted" />
          <span class="min-w-0 truncate">{label()}</span>
          <Icon name="chevron-down" size="small" class="shrink-0 text-kit-icon-icon-muted" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content class="w-[180px]">
            <Menu.Group>
              <Menu.GroupLabel>{language.t("session.new.workspace.runIn")}</Menu.GroupLabel>
              <Menu.Item onSelect={() => select("main")}>
                <KitIcon name="monitor" />
                <span class="min-w-0 flex-1 truncate">{language.t("session.new.workspace.local")}</span>
                <Show when={selected() === "main"}>
                  <Icon name="check" size="small" class="shrink-0" />
                </Show>
              </Menu.Item>
              <Menu.Item onSelect={() => select("create")}>
                <KitIcon name="workspace-new" />
                <span class="min-w-0 flex-1 truncate">{language.t("workspace.new")}</span>
                <Show when={selected() === "create"}>
                  <Icon name="check" size="small" class="shrink-0" />
                </Show>
              </Menu.Item>
            </Menu.Group>
            <Show when={props.workspaces.length > 0}>
              <Menu.Separator />
              <Menu.Sub gutter={0} overlap overflowPadding={8}>
                <Menu.SubTrigger>
                  <KitIcon name="workspace" />
                  {language.t("session.new.workspace.existing")}
                </Menu.SubTrigger>
                <Menu.Portal>
                  <Menu.SubContent class="max-w-[200px]">
                    <For each={props.workspaces}>
                      {(workspace) => (
                        <Menu.Item onSelect={() => select(workspace)}>
                          <KitIcon name="workspace-isolated" />
                          <span class="min-w-0 flex-1 truncate">{getFilename(workspace)}</span>
                          <Show when={selected() === workspace}>
                            <Icon name="check" size="small" class="shrink-0" />
                          </Show>
                        </Menu.Item>
                      )}
                    </For>
                  </Menu.SubContent>
                </Menu.Portal>
              </Menu.Sub>
            </Show>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
      <PromptGitStatus branch={props.branch} />
    </>
  )
}

export function PromptGitStatus(props: { branch?: string; noGit?: boolean }) {
  const language = useLanguage()
  const label = () => {
    if (props.noGit) return language.t("session.new.git.none")
    return props.branch
  }

  return (
    <Show when={label()}>
      {(value) => (
        <>
          <span class="hidden select-none opacity-50 sm:inline mx-1">/</span>
          <Tooltip
            placement="top"
            value={value()}
            class="min-w-0 max-w-[220px]"
            contentClass="max-w-[calc(100vw-32px)] break-all"
          >
            <div class="flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 px-2 text-[13px] font-[440] leading-5 tracking-[-0.04px]">
              <Icon name="branch" size="small" class="shrink-0 text-kit-icon-icon-muted" />
              <span class="min-w-0 truncate">{value()}</span>
            </div>
          </Tooltip>
        </>
      )}
    </Show>
  )
}
