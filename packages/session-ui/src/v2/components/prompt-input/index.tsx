import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Button } from "@opencode-ai/ui/kit/button"
import { Icon as KitIcon } from "@opencode-ai/ui/kit/icon"
import { IconButton as KitIconButton } from "@opencode-ai/ui/kit/icon-button"
import { Keybind } from "@opencode-ai/ui/kit/keybind"
import { Menu } from "@opencode-ai/ui/kit/menu"
import { Tooltip } from "@opencode-ai/ui/kit/tooltip"
import { AttachmentCard } from "../attachment-card"
import { CommentCard } from "../comment-card"
import { typeLabel } from "../../../components/message-file"
import type {
  PromptInputAttachment,
  PromptInputComment,
  PromptInputOption,
  PromptInputPersistedState,
  PromptInputPrompt,
  PromptInputSuggestion,
} from "./types"
import type { PromptInputInteraction, PromptInputSelectControl } from "./interaction"

export type {
  PromptInputAttachment,
  PromptInputComment,
  PromptInputOption,
  PromptInputPersistedState,
  PromptInputSuggestion,
} from "./types"

export type PromptInputMode = "normal" | "shell"

export type PromptInputProps = {
  controller: PromptInputInteraction
  disabled?: boolean
  readOnly?: boolean
  borderUnderlay?: boolean
  class?: string
  modelControl?: JSX.Element
  variantControlVisible?: boolean
  attachKeybind?: string[]
  attachShortcut?: string
}

export function PromptInput(props: PromptInputProps) {
  const state = props.controller.state
  const view = props.controller.view
  let editor: HTMLDivElement | undefined
  let localInput = false
  const updateCursor = () => {
    if (!editor || !window.getSelection()?.isCollapsed) return
    props.controller.onCursor(promptInputCursor(editor))
  }
  const mode = createMemo(() => state.mode)
  const buttons = createMemo(() => ({
    opacity: mode() === "normal" ? 1 : 0,
    "pointer-events": mode() === "normal" ? ("auto" as const) : ("none" as const),
    transition: "opacity 200ms ease",
  }))

  createEffect(() => {
    const parts = props.controller.parts()
    if (!editor) return
    if (localInput) {
      localInput = false
      return
    }
    renderPromptInputEditor(editor, parts)
  })

  return (
    <div class={`relative size-full flex flex-col gap-0 ${props.class ?? ""}`}>
      <input
        ref={props.controller.setFileInput}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,application/json,application/ld+json,application/toml,application/x-toml,application/x-yaml,application/xml,application/yaml,.c,.cc,.cjs,.conf,.cpp,.css,.csv,.cts,.env,.go,.gql,.graphql,.h,.hh,.hpp,.htm,.html,.ini,.java,.js,.json,.jsx,.log,.md,.mdx,.mjs,.mts,.py,.rb,.rs,.sass,.scss,.sh,.sql,.toml,.ts,.tsx,.txt,.xml,.yaml,.yml,.zsh"
        class="hidden"
        onChange={(event) => {
          const list = event.currentTarget.files
          if (list) props.controller.addAttachments(Array.from(list))
          event.currentTarget.value = ""
        }}
      />
      <Show when={state.popover.type !== "closed"}>
        <PromptInputPopover
          emptyLabel="No matching items"
          items={props.controller.suggestions()}
          activeID={state.popover.type === "closed" ? undefined : state.popover.activeID}
          search={
            state.popover.type === "command-menu"
              ? {
                  value: state.popover.query,
                  label: "Commands",
                  placeholder: "/",
                  onValueChange: props.controller.setQuery,
                  onKeyDown: props.controller.onKeyDown,
                }
              : undefined
          }
          onActiveChange={(item) => props.controller.dispatch({ type: "popover.active", id: item.id })}
          onSelect={(item) => props.controller.dispatch({ type: "popover.select", item })}
        />
      </Show>
      <form
        data-component="prompt-input"
        data-dock-border-underlay={props.borderUnderlay ? "current" : undefined}
        class="group/prompt-input relative min-h-[96px] w-full rounded-xl bg-kit-background-bg-base"
        classList={{
          "shadow-[var(--kit-elevation-raised)]": !props.borderUnderlay,
          "border border-kit-icon-icon-info border-dashed": state.drag === "active",
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!props.disabled) props.controller.submit()
        }}
        onDragEnter={props.controller.onDragEnter}
        onDragOver={props.controller.onDragOver}
        onDragLeave={props.controller.onDragLeave}
        onDrop={props.controller.onDrop}
      >
        <Show when={state.drag === "active"}>
          <div class="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl bg-kit-background-bg-base/90 text-kit-text-text-base">
            Drop files to attach
          </div>
        </Show>

        <Show when={state.mode === "normal"}>
          <PromptInputAttachments
            attachments={props.controller.attachments()}
            comments={props.controller.comments()}
            activeCommentID={state.activeContextID}
            removeLabel="Remove attachment"
            onAttachmentClick={props.controller.openAttachment}
            onAttachmentRemove={(attachment) => props.controller.removeAttachment(attachment.id)}
            onCommentClick={(comment) => props.controller.toggleContext(comment.key)}
            onCommentRemove={(comment) => props.controller.removeContext(comment.key)}
          />
        </Show>

        <div class="relative min-h-[60px]">
          <div
            ref={(element) => {
              editor = element
              props.controller.setEditor(element)
              renderPromptInputEditor(element, props.controller.parts())
            }}
            data-component="prompt-input"
            role="textbox"
            aria-multiline="true"
            aria-label="Prompt"
            contenteditable={!props.disabled && !props.readOnly}
            autocapitalize={state.mode === "normal" ? "sentences" : "off"}
            autocorrect={state.mode === "normal" ? "on" : "off"}
            spellcheck={state.mode === "normal"}
            // @ts-expect-error
            autocomplete="off"
            class="relative z-10 block min-h-[60px] max-h-[180px] w-full overflow-y-auto whitespace-pre-wrap bg-transparent px-4 pt-4 pb-2 text-[13px] font-[440] leading-5 text-kit-text-text-base focus:outline-none empty:before:content-['\200B'] [&_[data-mention=file]]:text-syntax-property [&_[data-mention=agent]]:text-syntax-type [&_[data-mention=reference]]:text-syntax-keyword"
            classList={{ "font-mono!": state.mode === "shell", "opacity-50": props.disabled }}
            onInput={(event) => {
              const cursor = promptInputCursor(event.currentTarget)
              const prompt = parsePromptInputEditor(event.currentTarget)
              const images = props.controller.parts().filter((part) => part.type === "image")
              localInput = true
              props.controller.onInput(prompt.map((part) => part.content).join(""), [...prompt, ...images], cursor)
            }}
            onKeyDown={(event) => {
              if (props.controller.onKeyDown(event)) return
              if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                event.preventDefault()
                if (event.repeat) return
                props.controller.submit()
              }
            }}
            onKeyUp={updateCursor}
            onPointerUp={updateCursor}
            onPaste={props.controller.onPaste}
            onFocus={() => props.controller.dispatch({ type: "focus.editor" })}
          />
          <Show when={!props.controller.value()}>
            <div
              class="pointer-events-none absolute inset-x-0 top-0 px-4 pt-4 text-[13px] font-[440] leading-5 text-kit-text-text-faint"
              classList={{ "font-mono!": state.mode === "shell" }}
            >
              {view.placeholder?.() ??
                (state.mode === "shell" ? "Enter shell command..." : "Ask anything, / for commands, @ for context...")}
            </div>
          </Show>
        </div>

        <div class="flex h-11 items-center px-2">
          <div
            class="flex min-w-0 flex-1 items-center gap-1"
            aria-hidden={state.mode === "shell"}
            inert={state.mode === "shell" ? true : undefined}
            style={buttons()}
          >
            <PromptInputAddMenu
              disabled={state.mode === "shell"}
              title="Add images and files"
              keybind={props.attachKeybind ?? ["Mod", "U"]}
              attachLabel="Images and files"
              attachShortcut={props.attachShortcut ?? "Mod+U"}
              commandsLabel="Commands"
              contextLabel="Context"
              shellLabel="Shell command"
              onAttach={props.controller.attach}
              onCommands={props.controller.openCommands}
              onContext={props.controller.openContext}
              onShell={props.controller.openShell}
            />
            <Show when={view.agent}>
              {(control) => (
                <PromptInputConfiguredSelect title="Choose agent" keybind={["Mod", "."]} control={control()} />
              )}
            </Show>
            <Show
              when={props.modelControl}
              fallback={
                <Show when={view.model}>
                  {(control) => (
                    <PromptInputConfiguredSelect
                      title="Choose model"
                      keybind={["Mod", "M"]}
                      control={control()}
                      model
                    />
                  )}
                </Show>
              }
            >
              {props.modelControl}
            </Show>
            <Show when={(props.variantControlVisible ?? true) && view.variant}>
              {(control) => (
                <Show when={control().options().length > 1}>
                  <PromptInputConfiguredSelect
                    title="Choose model variant"
                    keybind={["Shift", "Mod", "D"]}
                    control={control()}
                  />
                </Show>
              )}
            </Show>
          </div>
          <PromptInputSubmitButton
            mode={state.mode}
            stopping={view.submit.stopping()}
            disabled={!props.controller.canSubmit()}
            sendLabel="Send"
            stopLabel="Stop"
            onSubmit={props.controller.submit}
            onStop={props.controller.stop}
          />
        </div>
      </form>
    </div>
  )
}

function renderPromptInputEditor(editor: HTMLDivElement, prompt: PromptInputPrompt) {
  const active = document.activeElement === editor
  editor.replaceChildren(
    ...prompt.flatMap<Node>((part) => {
      if (part.type === "image") return []
      if (part.type === "text") return [document.createTextNode(part.content)]
      const mention = document.createElement("span")
      mention.textContent = part.content
      mention.contentEditable = "false"
      mention.dataset.mention =
        part.type === "file" && part.mime === "application/x-directory" ? "reference" : part.type
      if (part.type === "agent") mention.dataset.name = part.name
      if (part.type === "file") {
        mention.dataset.path = part.path
        if (part.mime) mention.dataset.mime = part.mime
        if (part.filename) mention.dataset.filename = part.filename
      }
      return [mention]
    }),
  )
  if (!active) return
  const selection = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function parsePromptInputEditor(editor: HTMLDivElement) {
  const parts: Exclude<PromptInputPrompt[number], PromptInputAttachment>[] = []
  let buffer = ""
  let position = 0

  const flush = () => {
    if (!buffer) return
    parts.push({ type: "text", content: buffer, start: position, end: position + buffer.length })
    position += buffer.length
    buffer = ""
  }
  const mention = (element: HTMLElement) => {
    flush()
    const content = element.textContent ?? ""
    if (element.dataset.mention === "agent") {
      parts.push({
        type: "agent",
        name: element.dataset.name ?? content.slice(1),
        content,
        start: position,
        end: position + content.length,
      })
      position += content.length
      return
    }
    parts.push({
      type: "file",
      path: element.dataset.path ?? content.slice(1),
      content,
      start: position,
      end: position + content.length,
      ...(element.dataset.mime ? { mime: element.dataset.mime } : {}),
      ...(element.dataset.filename ? { filename: element.dataset.filename } : {}),
    })
    position += content.length
  }
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent ?? ""
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.mention) {
      mention(node)
      return
    }
    if (node.tagName === "BR") {
      buffer += "\n"
      return
    }
    Array.from(node.childNodes).forEach(visit)
  }

  Array.from(editor.childNodes).forEach((node, index, nodes) => {
    visit(node)
    if (node instanceof HTMLElement && ["DIV", "P"].includes(node.tagName) && index < nodes.length - 1) buffer += "\n"
  })
  flush()
  if (
    parts.every((part) => part.type === "text") &&
    parts.every((part) => part.content.replace(/[\n\u200B]/g, "") === "")
  ) {
    return [{ type: "text" as const, content: "", start: 0, end: 0 }]
  }
  if (parts.length > 0) return parts
  return [{ type: "text" as const, content: "", start: 0, end: 0 }]
}

function promptInputCursor(editor: HTMLDivElement) {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return editor.textContent?.length ?? 0
  const range = selection.getRangeAt(0).cloneRange()
  range.selectNodeContents(editor)
  range.setEnd(selection.anchorNode!, selection.anchorOffset)
  return range.toString().length
}

export function PromptInputAttachments(props: {
  attachments: PromptInputAttachment[]
  comments?: PromptInputComment[]
  activeCommentID?: string
  removeLabel: string
  onAttachmentClick?: (attachment: PromptInputAttachment) => void
  onAttachmentRemove: (attachment: PromptInputAttachment) => void
  onCommentClick?: (comment: PromptInputComment) => void
  onCommentRemove?: (comment: PromptInputComment) => void
}) {
  return (
    <Show when={props.attachments.length > 0 || (props.comments?.length ?? 0) > 0}>
      <div data-slot="prompt-attachments" class="relative">
        <div
          data-slot="prompt-attachments-scroll"
          class="flex flex-nowrap gap-2 overflow-x-auto no-scrollbar px-2 pt-2 pb-1"
        >
          <For each={props.comments ?? []}>
            {(comment) => (
              <div class="relative group shrink-0">
                <Tooltip
                  value={comment.comment}
                  placement="top"
                  openDelay={800}
                  contentClass="max-w-[300px] break-words"
                >
                  <CommentCard
                    comment={comment.comment ?? ""}
                    path={comment.path}
                    selection={comment.selection}
                    active={comment.key === props.activeCommentID}
                    onClick={() => props.onCommentClick?.(comment)}
                  />
                </Tooltip>
                <button
                  type="button"
                  onClick={() => props.onCommentRemove?.(comment)}
                  class="absolute -top-1 -right-1 size-4 rounded-full bg-kit-icon-icon-muted outline-solid outline-1 outline-kit-icon-icon-contrast flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={props.removeLabel}
                >
                  <KitIcon name="outline-xmark" class="text-kit-icon-icon-contrast" />
                </button>
              </div>
            )}
          </For>
          <For each={props.attachments}>
            {(attachment) => (
              <div class="relative group shrink-0">
                <Tooltip value={attachment.filename} placement="top" contentClass="break-all">
                  <Show
                    when={attachment.mime.startsWith("image/")}
                    fallback={
                      <AttachmentCard title={attachment.filename}>
                        {typeLabel(attachment.filename, attachment.mime)}
                      </AttachmentCard>
                    }
                  >
                    <img
                      src={attachment.dataUrl}
                      alt={attachment.filename}
                      class="w-[58px] h-[46px] rounded-[6px] object-cover"
                      onClick={() => props.onAttachmentClick?.(attachment)}
                    />
                    <div class="absolute inset-0 rounded-[6px] shadow-[inset_0_0_0_0.5px_var(--kit-border-border-base)] pointer-events-none" />
                  </Show>
                </Tooltip>
                <button
                  type="button"
                  onClick={() => props.onAttachmentRemove(attachment)}
                  class="absolute -top-1 -right-1 size-4 rounded-full bg-kit-icon-icon-muted outline-solid outline-1 outline-kit-icon-icon-contrast flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label={props.removeLabel}
                >
                  <KitIcon name="outline-xmark" class="text-kit-icon-icon-contrast" />
                </button>
              </div>
            )}
          </For>
        </div>
        <div class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--kit-background-bg-base),transparent)]" />
        <div class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--kit-background-bg-base),transparent)]" />
      </div>
    </Show>
  )
}

export function PromptInputAddMenu(props: {
  disabled?: boolean
  title: string
  keybind?: string[]
  attachLabel: string
  attachShortcut?: string
  commandsLabel: string
  contextLabel: string
  shellLabel: string
  onAttach: () => void
  onCommands: () => void
  onContext: () => void
  onShell: () => void
}) {
  return (
    <Tooltip
      placement="top"
      value={
        <>
          {props.title}
          <Keybind keys={props.keybind ?? []} variant="neutral" />
        </>
      }
    >
      <Menu gutter={6} modal={false} placement="top-start">
        <Menu.Trigger
          as={KitIconButton}
          data-action="prompt-attach"
          type="button"
          icon={<KitIcon name="plus" />}
          variant="ghost-muted"
          size="large"
          disabled={props.disabled}
          aria-label={props.title}
        />
        <Menu.Portal>
          <Menu.Content style={{ "min-width": "180px" }}>
            <Menu.Item onSelect={props.onAttach} shortcut={props.attachShortcut}>
              {props.attachLabel}
            </Menu.Item>
            <Menu.Separator />
            <Menu.Item onSelect={props.onCommands} shortcut="/">
              {props.commandsLabel}
            </Menu.Item>
            <Menu.Item onSelect={props.onContext} shortcut="@">
              {props.contextLabel}
            </Menu.Item>
            <Menu.Item onSelect={props.onShell} shortcut="!">
              {props.shellLabel}
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </Tooltip>
  )
}

function PromptInputConfiguredSelect(props: {
  title: string
  keybind?: string[]
  control: PromptInputSelectControl
  model?: boolean
}) {
  const current = () => props.control.current()
  const providerID = () => props.control.options().find((option) => option.id === current())?.providerID
  return (
    <PromptInputSelect
      title={props.title}
      keybind={props.control.keybind?.() ?? props.keybind}
      options={props.control.options()}
      current={current()}
      currentIcon={
        <Show when={props.model && providerID()}>
          <ProviderIcon id={providerID()!} class="size-4 shrink-0 opacity-60" />
        </Show>
      }
      onSelect={props.control.onSelect}
    />
  )
}

export function PromptInputSelect(props: {
  title: string
  keybind?: string[]
  options: PromptInputOption[]
  current: string
  currentIcon?: JSX.Element
  class?: string
  onOpenChange?: (open: boolean) => void
  onSelect: (id: string) => void
}) {
  return (
    <Tooltip
      placement="top"
      value={
        <>
          {props.title}
          <Keybind keys={props.keybind ?? []} variant="neutral" />
        </>
      }
    >
      <Menu gutter={6} modal={false} placement="top-start" onOpenChange={props.onOpenChange}>
        <Menu.Trigger
          as={Button}
          variant="ghost-muted"
          size="normal"
          class={`max-w-[220px] justify-start ![font-weight:440] ${props.class ?? ""}`}
          aria-label={props.title}
        >
          {props.currentIcon}
          <span class="truncate capitalize leading-5">
            {props.options.find((option) => option.id === props.current)?.label ?? props.current}
          </span>
          <span class="-ml-0.5 -mr-1 flex shrink-0">
            <KitIcon name="chevron-down" />
          </span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content>
            <Menu.RadioGroup value={props.current} onChange={props.onSelect}>
              <For each={props.options}>
                {(option) => (
                  <Menu.RadioItem value={option.id} class="capitalize" closeOnSelect>
                    {option.label}
                  </Menu.RadioItem>
                )}
              </For>
            </Menu.RadioGroup>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </Tooltip>
  )
}

export function PromptInputPopover(props: {
  emptyLabel: string
  items: PromptInputSuggestion[]
  activeID?: string
  search?: {
    value: string
    label: string
    placeholder: string
    onValueChange: (value: string) => void
    onKeyDown: (event: KeyboardEvent) => void
  }
  onActiveChange: (item: PromptInputSuggestion) => void
  onSelect: (item: PromptInputSuggestion) => void
}) {
  return (
    <div
      class="absolute inset-x-0 -top-2 z-40 flex max-h-80 -translate-y-full flex-col overflow-auto rounded-xl bg-kit-background-bg-base p-2 shadow-[var(--kit-elevation-raised)] no-scrollbar"
      onMouseDown={(event) => event.preventDefault()}
    >
      <Show when={props.search}>
        {(search) => (
          <div class="px-2 py-1">
            <input
              ref={(element) => requestAnimationFrame(() => element.focus())}
              value={search().value}
              aria-label={search().label}
              placeholder={search().placeholder}
              class="w-full bg-transparent text-[13px] leading-5 text-kit-text-text-base outline-none placeholder:text-kit-text-text-faint"
              onInput={(event) => search().onValueChange(event.currentTarget.value)}
              onKeyDown={(event) => search().onKeyDown(event)}
              onMouseDown={(event) => event.stopPropagation()}
            />
          </div>
        )}
      </Show>
      <Show
        when={props.items.length > 0}
        fallback={<div class="px-2 py-1 text-kit-text-text-muted">{props.emptyLabel}</div>}
      >
        <For each={props.items}>
          {(item) => (
            <button
              type="button"
              data-suggestion-id={item.id}
              class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-kit-overlay-simple-overlay-hover"
              classList={{ "bg-kit-overlay-simple-overlay-hover": props.activeID === item.id }}
              onPointerMove={() => props.onActiveChange(item)}
              onClick={() => props.onSelect(item)}
            >
              <div class="flex min-w-0 flex-1 items-center gap-2">
                <PromptInputSuggestionIcon item={item} />
                <span class="shrink-0 text-kit-text-text-base">{item.label}</span>
                <Show when={item.description}>
                  <span class="min-w-0 truncate text-kit-text-text-muted">{item.description}</span>
                </Show>
              </div>
              <Show when={item.keybind?.length}>
                <span class="shrink-0 text-kit-text-text-muted">{item.keybind?.join("+")}</span>
              </Show>
            </button>
          )}
        </For>
      </Show>
    </div>
  )
}

export function PromptInputSubmitButton(props: {
  mode: PromptInputMode
  stopping: boolean
  disabled: boolean
  sendLabel: string
  stopLabel: string
  onSubmit: () => void
  onStop: () => void
}) {
  return (
    <Tooltip
      placement="top"
      inactive={!props.stopping && props.disabled}
      value={props.stopping ? props.stopLabel : props.sendLabel}
    >
      <IconButton
        data-action="prompt-submit"
        type="button"
        disabled={!props.stopping && props.disabled}
        tabIndex={props.mode === "normal" ? undefined : -1}
        icon={props.stopping ? "stop" : props.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
        variant="primary"
        class="size-7 rounded-md p-[6px] text-kit-icon-icon-muted shadow-[var(--kit-elevation-button-contrast)] disabled:opacity-50"
        style={{
          "background-image":
            "linear-gradient(180deg,var(--kit-alpha-light-20) 0%,var(--kit-alpha-light-0) 100%),linear-gradient(90deg,var(--kit-background-bg-contrast) 0%,var(--kit-background-bg-contrast) 100%)",
        }}
        aria-label={props.stopping ? props.stopLabel : props.sendLabel}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          if (props.stopping) {
            props.onStop()
            return
          }
          props.onSubmit()
        }}
      />
    </Tooltip>
  )
}

function PromptInputSuggestionIcon(props: { item: PromptInputSuggestion }) {
  if (props.item.kind === "agent") return <Icon name="brain" size="small" class="shrink-0 text-icon-info-active" />
  if (props.item.kind === "command") return null
  return (
    <FileIcon
      node={{ path: props.item.path ?? props.item.label, type: props.item.kind === "reference" ? "directory" : "file" }}
      class="size-4 shrink-0"
    />
  )
}
