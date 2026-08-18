import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tag } from "@opencode-ai/ui/kit/badge"
import { Button } from "@opencode-ai/ui/kit/button"
import { Icon as KitIcon } from "@opencode-ai/ui/kit/icon"
import { IconButton } from "@opencode-ai/ui/kit/icon-button"
import { Menu } from "@opencode-ai/ui/kit/menu"
import { useMutation } from "@tanstack/solid-query"
import fuzzysort from "fuzzysort"
import { type Accessor, For, Show, createMemo } from "solid-js"
import type { useServerManagementController } from "@/components/dialog-select-server"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { showToast } from "@/utils/toast"
import { DialogAddWslServer } from "./dialog-add-server"
import { useWslServers } from "./context"
import { wslOpencodeAction, wslRuntimeRetryable } from "./settings-model"

type Controller = ReturnType<typeof useServerManagementController>

export function isWslServer(server: ServerConnection.Any) {
  return server.type === "sidecar" && server.variant === "wsl"
}

export function AddServerMenu(props: { onAddServer: () => void }) {
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const openAddWsl = () => {
    dialog.push(() => <DialogAddWslServer />)
  }
  return (
    <Show
      when={platform.wslServers}
      fallback={
        <Button variant="ghost-muted" icon="plus" onClick={props.onAddServer}>
          {language.t("dialog.server.add.button")}
        </Button>
      }
    >
      <Menu gutter={4} modal={false} placement="bottom-end">
        <Menu.Trigger as={Button} variant="ghost-muted" icon="plus">
          {language.t("dialog.server.add.button")}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content>
            <Menu.Item onSelect={props.onAddServer}>{language.t("dialog.server.add.button")}</Menu.Item>
            <Menu.Item onSelect={openAddWsl}>{language.t("wsl.server.add")}</Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </Show>
  )
}

export function useFilteredWslServers(filter: Accessor<string>) {
  const wsl = useWslServers()
  return createMemo(() => {
    const servers = wsl.data?.servers ?? []
    const query = filter().trim()
    if (!query) return servers
    return fuzzysort
      .go(query, servers, { keys: [(item) => item.config.distro, (item) => item.config.id] })
      .map((x) => x.obj)
  })
}

export function WslServerSettings(props: {
  controller: Controller
  servers: ReturnType<typeof useFilteredWslServers>
}) {
  const platform = usePlatform()
  const language = useLanguage()
  const wsl = useWslServers()
  const api = platform.wslServers

  const request = useMutation(() => ({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  }))

  const remove = (key: ServerConnection.Key) => {
    request.mutate(() => props.controller.handleRemove(key))
  }

  return (
    <Show when={api}>
      <For each={props.servers()}>
        {(item) => {
          const key = ServerConnection.Key.make(item.config.id)
          const check = () => wsl.data?.opencodeChecks[item.config.distro]
          const opencodeAction = () => wslOpencodeAction(check())
          const busy = () => wsl.data?.job?.kind === "install-opencode" && wsl.data.job.distro === item.config.distro
          return (
            <div class="settings-kit-servers-row">
              <div class="settings-kit-servers-lead">
                <ServerHealthIndicator health={props.controller.status()[key]} />
                <div class="settings-kit-servers-copy">
                  <span class="flex min-w-0 items-center gap-1">
                    <span class="settings-kit-servers-name">{item.config.distro}</span>
                    <span class="shrink-0 rounded-[3px] border border-kit-border-border-base px-1 py-0.5 text-[9px] leading-none text-kit-text-text-muted">
                      {language.t("wsl.server.label")}
                    </span>
                  </span>
                  <span class="settings-kit-servers-meta">
                    <Show when={check()?.version}>{(version) => `v${version()}`}</Show>
                  </span>
                </div>
              </div>
              <div class="settings-kit-servers-actions">
                <Show when={props.controller.canDefault() && props.controller.defaultKey() === key}>
                  <Tag>{language.t("dialog.server.status.default")}</Tag>
                </Show>
                <Show when={opencodeAction()}>
                  {(label) => (
                    <Button
                      size="small"
                      disabled={busy() || request.isPending}
                      onClick={() => api && request.mutate(() => api.installOpencode(item.config.distro))}
                    >
                      {busy() ? language.t("wsl.server.updating") : label()}
                    </Button>
                  )}
                </Show>
                <Menu gutter={4} modal={false} placement="bottom-end">
                  <Menu.Trigger
                    as={IconButton}
                    variant="ghost-muted"
                    size="small"
                    icon={<KitIcon name="outline-dots" />}
                    aria-label={language.t("common.moreOptions")}
                  />
                  <Menu.Portal>
                    <Menu.Content>
                      <Menu.Group>
                        <Menu.GroupLabel>{language.t("wsl.server.menu.label")}</Menu.GroupLabel>
                        <Show when={wslRuntimeRetryable(item.runtime)}>
                          <Menu.Item onSelect={() => api && request.mutate(() => api.startServer(key))}>
                            {language.t("wsl.server.retryStart")}
                          </Menu.Item>
                        </Show>
                        <Show when={props.controller.canDefault() && props.controller.defaultKey() !== key}>
                          <Menu.Item onSelect={() => props.controller.setDefault(key)}>
                            {language.t("dialog.server.menu.default")}
                          </Menu.Item>
                        </Show>
                        <Show when={props.controller.canDefault() && props.controller.defaultKey() === key}>
                          <Menu.Item onSelect={() => props.controller.setDefault(null)}>
                            {language.t("dialog.server.menu.defaultRemove")}
                          </Menu.Item>
                        </Show>
                        <Menu.Separator />
                        <Menu.Item onSelect={() => remove(key)}>
                          {language.t("dialog.server.menu.delete")}
                        </Menu.Item>
                      </Menu.Group>
                    </Menu.Content>
                  </Menu.Portal>
                </Menu>
              </div>
            </div>
          )
        }}
      </For>
    </Show>
  )
}
