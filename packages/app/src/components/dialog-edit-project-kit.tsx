import { Button } from "@opencode-ai/ui/kit/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/kit/dialog"
import { Divider } from "@opencode-ai/ui/kit/divider"
import { Field } from "@opencode-ai/ui/kit/field"
import { Icon } from "@opencode-ai/ui/kit/icon"
import { ProjectAvatar, PROJECT_AVATAR_VARIANTS } from "@opencode-ai/ui/kit/project-avatar"
import { Textarea } from "@opencode-ai/ui/kit/textarea"
import { TextInput } from "@opencode-ai/ui/kit/text-input"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { getProjectAvatarVariant, type LocalProject } from "@/context/layout"
import { ServerConnection } from "@/context/server"
import { getProjectAvatarSource } from "@/pages/layout/helpers"
import { createEditProjectModel } from "./edit-project"

export function DialogEditProject(props: { project: LocalProject; server: ServerConnection.Any }) {
  const language = useLanguage()
  const model = createEditProjectModel(props)

  return (
    <Dialog fit>
      <form onSubmit={model.submit} class="contents">
        <DialogHeader>
          <DialogTitle>{language.t("dialog.project.edit.title")}</DialogTitle>
        </DialogHeader>
        <Divider />
        <DialogBody class="flex max-h-[min(560px,calc(100vh-160px))] w-full flex-col gap-6 overflow-y-auto px-4 pt-4 pb-1">
          <Field>
            <Field.Label>{language.t("dialog.project.edit.name")}</Field.Label>
            <TextInput
              autofocus
              appearance="large"
              class="!w-full"
              value={model.store.name}
              placeholder={model.folderName()}
              onInput={(event) => model.setStore("name", event.currentTarget.value)}
            />
          </Field>

          <div class="flex w-full flex-col gap-2">
            <div class="select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-kit-text-text-base">
              {language.t("dialog.project.edit.icon")}
            </div>
            <div class="flex items-center gap-3">
              <button
                type="button"
                aria-label={language.t("dialog.project.edit.icon.alt")}
                class="relative size-16 shrink-0 cursor-pointer overflow-hidden rounded-[6px] outline outline-1 outline-transparent transition-[background-color,outline-color] focus-visible:outline-kit-border-border-focus"
                classList={{
                  "bg-kit-overlay-simple-overlay-hover outline-kit-border-border-focus": model.store.dragOver,
                }}
                onMouseEnter={() => model.setStore("iconHover", true)}
                onMouseLeave={() => model.setStore("iconHover", false)}
                onDrop={model.drop}
                onDragOver={model.dragOver}
                onDragLeave={model.dragLeave}
                onClick={model.iconClick}
              >
                <ProjectAvatar
                  fallback={model.store.name || model.defaultName()}
                  src={getProjectAvatarSource(props.project.id, {
                    color: model.store.color,
                    url: props.project.icon?.url,
                    override: model.store.iconOverride,
                  })}
                  variant={getProjectAvatarVariant(model.store.color)}
                  class="!size-16 [&_[data-slot=project-avatar-surface]]:!rounded-[6px] [&_[data-slot=project-avatar-surface]]:!text-[32px]"
                />
                <span
                  class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[6px] bg-kit-background-bg-contrast/80 text-kit-icon-icon-contrast backdrop-blur-[2px] transition-opacity"
                  classList={{
                    "opacity-100": model.store.iconHover,
                    "opacity-0": !model.store.iconHover,
                  }}
                >
                  <Icon name={model.store.iconOverride ? "close" : "outline-share"} />
                </span>
              </button>
              <input
                ref={(element) => {
                  model.setIconInput(element)
                }}
                type="file"
                accept="image/*"
                class="hidden"
                onChange={model.inputChange}
              />
              <div class="flex select-none flex-col gap-[6px] text-[11px] font-[440] leading-none tracking-[0.05px] text-kit-text-text-muted">
                <span>{language.t("dialog.project.edit.icon.hint")}</span>
                <span>{language.t("dialog.project.edit.icon.recommended")}</span>
              </div>
            </div>
          </div>

          <Show when={!model.store.iconOverride}>
            <div class="flex w-full flex-col gap-2">
              <div class="select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-kit-text-text-base">
                {language.t("dialog.project.edit.color")}
              </div>
              <div class="-ml-1 flex gap-1.5">
                <For each={PROJECT_AVATAR_VARIANTS}>
                  {(color) => (
                    <button
                      type="button"
                      aria-label={language.t("dialog.project.edit.color.select", { color })}
                      aria-pressed={getProjectAvatarVariant(model.store.color) === color}
                      class="flex size-8 items-center justify-center rounded-[10px] p-1 outline outline-1 outline-transparent transition-[background-color,outline-color] hover:bg-kit-overlay-simple-overlay-hover focus-visible:outline-kit-border-border-focus"
                      classList={{
                        "bg-kit-overlay-simple-overlay-hover [box-shadow:inset_0_0_0_2px_var(--kit-border-border-focus)]":
                          getProjectAvatarVariant(model.store.color) === color,
                      }}
                      onClick={() => {
                        if (getProjectAvatarVariant(model.store.color) === color && !props.project.icon?.url) return
                        model.setStore(
                          "color",
                          getProjectAvatarVariant(model.store.color) === color ? undefined : color,
                        )
                      }}
                    >
                      <ProjectAvatar
                        fallback={model.store.name || model.defaultName()}
                        variant={getProjectAvatarVariant(color)}
                        class="!size-6 [&_[data-slot=project-avatar-surface]]:!rounded-[6px]"
                      />
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Field>
            <Field.Label>{language.t("dialog.project.edit.worktree.startup")}</Field.Label>
            <Field.Prefix>{language.t("dialog.project.edit.worktree.startup.description")}</Field.Prefix>
            <Textarea
              class="!w-full [&_[data-slot=textarea-kit-textarea]]:font-mono"
              rows={3}
              value={model.store.startup}
              placeholder={language.t("dialog.project.edit.worktree.startup.placeholder")}
              spellcheck={false}
              onInput={(event) => model.setStore("startup", event.currentTarget.value)}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="neutral" disabled={model.save.isPending} onClick={model.close}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="contrast" disabled={model.save.isPending}>
            {model.save.isPending ? language.t("common.saving") : language.t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
