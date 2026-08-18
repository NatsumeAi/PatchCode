import { Tabs as Kobalte } from "@kobalte/core/tabs"
import { Show, splitProps, type JSX } from "solid-js"
import type { ComponentProps, ParentProps, Component } from "solid-js"
import "./tabs.css"

export interface TabsProps extends ComponentProps<typeof Kobalte> {
  variant?: "normal" | "pill" | "settings"
  orientation?: "horizontal" | "vertical"
}
export interface TabsListProps extends ComponentProps<typeof Kobalte.List> {}
export interface TabsTriggerProps extends ComponentProps<typeof Kobalte.Trigger> {
  onMiddleClick?: () => void
  /** Optional subtext shown beside the primary content (muted style) */
  subtext?: JSX.Element | string
}
export interface TabsCloseButtonProps extends ComponentProps<"div"> {}
export interface TabsContentProps extends ComponentProps<typeof Kobalte.Content> {}

function TabsRoot(props: TabsProps) {
  const [split, rest] = splitProps(props, ["class", "classList", "variant", "orientation"])
  return (
    <Kobalte
      {...rest}
      orientation={split.orientation}
      data-component="tabs"
      data-variant={split.variant || "normal"}
      data-orientation={split.orientation || "horizontal"}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    />
  )
}

function TabsList(props: TabsListProps) {
  const [split, rest] = splitProps(props, ["class", "classList"])
  return (
    <Kobalte.List
      {...rest}
      data-slot="tabs-kit-list"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    />
  )
}

function TabsTrigger(props: ParentProps<TabsTriggerProps>) {
  const [split, rest] = splitProps(props, ["class", "classList", "children", "onMiddleClick", "subtext"])
  return (
    <div
      data-slot="tabs-kit-trigger-wrapper"
      data-value={props.value}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      onMouseDown={(e) => {
        if (e.button === 1 && split.onMiddleClick) {
          e.preventDefault()
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && split.onMiddleClick) {
          e.preventDefault()
          split.onMiddleClick()
        }
      }}
    >
      <Kobalte.Trigger {...rest} data-slot="tabs-kit-trigger" data-value={props.value}>
        <span class="inline-flex items-center gap-2" data-slot="tabs-kit-trigger-content">
          {split.children}
          <Show when={split.subtext}>
            {(subtext) => (
              <span data-slot="tabs-kit-subtext" class="ml-2 text-xs text-text-weak">
                {subtext()}
              </span>
            )}
          </Show>
        </span>
      </Kobalte.Trigger>
    </div>
  )
}

function TabsCloseButton(props: TabsCloseButtonProps) {
  const [split, rest] = splitProps(props, ["class", "classList", "onClick"])
  return (
    <div
      role="button"
      tabindex={0}
      aria-label="Close tab"
      data-slot="tabs-kit-close-button"
      {...rest}
      classList={{
        [split.class ?? ""]: !!split.class,
        ...split.classList,
      }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (typeof split.onClick === "function") {
          split.onClick(e)
        }
      }}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M10.8889 3.11108L3.11108 10.8889" stroke="currentColor" stroke-linejoin="round" />
        <path d="M3.11108 3.11108L10.8889 10.8889" stroke="currentColor" stroke-linejoin="round" />
      </svg>
    </div>
  )
}

function TabsContent(props: ParentProps<TabsContentProps>) {
  const [split, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Content
      {...rest}
      data-slot="tabs-kit-content"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </Kobalte.Content>
  )
}

const TabsSectionTitle: Component<ParentProps> = (props) => {
  return <div data-slot="tabs-kit-section-title">{props.children}</div>
}

export const Tabs = Object.assign(TabsRoot, {
  List: TabsList,
  Trigger: TabsTrigger,
  CloseButton: TabsCloseButton,
  Content: TabsContent,
  SectionTitle: TabsSectionTitle,
})
