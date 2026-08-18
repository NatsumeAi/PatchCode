import { Tag } from "@opencode-ai/ui/kit/badge"
import { Icon as KitIcon } from "@opencode-ai/ui/kit/icon"
import { IconButton } from "@opencode-ai/ui/kit/icon-button"
import { TextInput } from "@opencode-ai/ui/kit/text-input"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import fuzzysort from "fuzzysort"
import { type Component, For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { ServerRowMenu } from "@/components/server/server-row-menu"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { ServerConnection, serverName } from "@/context/server"
import { useServerManagementController } from "../dialog-select-server"
import { DialogServer } from "./dialog-server"
import { SettingsList } from "./parts/list"
import { AddServerMenu, isWslServer, useFilteredWslServers, WslServerSettings } from "@/wsl/settings"
import "./settings.css"

export const SettingsServers: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const controller = useServerManagementController()
  const [store, setStore] = createStore({ filter: "" })
  const wslServers = useFilteredWslServers(() => store.filter)

  const showSearch = createMemo(
    () => controller.sortedItems().filter((item) => !isWslServer(item)).length + wslServers().length > 1,
  )

  const filtered = createMemo(() => {
    const items = controller.sortedItems().filter((item) => !isWslServer(item))
    const query = store.filter.trim()
    if (!query) return items
    return fuzzysort
      .go(query, items, {
        keys: [(item) => serverName(item), (item) => item.http.url],
      })
      .map((result) => result.obj)
  })

  const openAdd = () => {
    dialog.push(() => <DialogServer mode="add" />)
  }

  const openEdit = (server: ServerConnection.Http) => {
    dialog.push(() => <DialogServer mode="edit" server={server} />)
  }

  return (
    <>
      <div
        class="settings-kit-tab-header settings-kit-servers-header"
        classList={{ "settings-kit-tab-header--stacked": showSearch() }}
      >
        <div class="settings-kit-tab-header-row">
          <h2 class="settings-kit-tab-title">{language.t("status.popover.tab.servers")}</h2>
          <AddServerMenu onAddServer={openAdd} />
        </div>
        <Show when={showSearch()}>
          <div class="settings-kit-tab-search">
            <TextInput
              type="search"
              appearance="base"
              value={store.filter}
              onInput={(event) => setStore("filter", event.currentTarget.value)}
              placeholder={language.t("dialog.server.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("dialog.server.search.placeholder")}
            />
            <Show when={store.filter}>
              <IconButton
                type="button"
                variant="ghost-muted"
                size="small"
                class="settings-kit-tab-search-clear"
                icon={<KitIcon name="close" size="large" class="text-kit-icon-icon-muted" />}
                onClick={() => setStore("filter", "")}
              />
            </Show>
          </div>
        </Show>
      </div>

      <div class="settings-kit-tab-body settings-kit-servers">
        <Show
          when={filtered().length > 0 || wslServers().length > 0}
          fallback={
            <div class="settings-kit-servers-status">
              <span>{store.filter ? language.t("palette.empty") : language.t("dialog.server.empty")}</span>
              <Show when={store.filter}>
                <span class="settings-kit-servers-status-filter">&quot;{store.filter}&quot;</span>
              </Show>
            </div>
          }
        >
          <SettingsList>
            <WslServerSettings controller={controller} servers={wslServers} />
            <For each={filtered()}>
              {(item) => {
                const key = ServerConnection.key(item)
                const health = () => controller.status()[key]
                const isDefault = () => controller.defaultKey() === key
                return (
                  <div class="settings-kit-servers-row">
                    <div class="settings-kit-servers-lead">
                      <ServerHealthIndicator health={health()} />
                      <div class="settings-kit-servers-copy">
                        <span class="settings-kit-servers-name">{serverName(item)}</span>
                        <span class="settings-kit-servers-meta">
                          <Show when={health()?.version}>v{health()?.version}</Show>
                          <Show when={health()?.version && item.type === "http"}> • </Show>
                          <Show
                            when={item.type === "http" && item.http.username}
                            fallback={<Show when={item.type === "http"}>{language.t("server.row.noUsername")}</Show>}
                          >
                            {item.http.username}
                          </Show>
                        </span>
                      </div>
                    </div>
                    <div class="settings-kit-servers-actions">
                      <Show when={controller.canDefault() && isDefault()}>
                        <Tag>{language.t("dialog.server.status.default")}</Tag>
                      </Show>
                      <ServerRowMenu server={item} controller={controller} onEdit={openEdit} />
                    </div>
                  </div>
                )
              }}
            </For>
          </SettingsList>
        </Show>
      </div>
    </>
  )
}
