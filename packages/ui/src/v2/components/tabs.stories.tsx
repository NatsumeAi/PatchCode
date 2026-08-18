import { Show } from "solid-js"
import * as mod from "./tabs"
import type { TabsProps } from "./tabs"

const docs = `
Tabbed navigation for switching between related panels. Compose \`Tabs.List\` + \`Tabs.Trigger\` + \`Tabs.Content\`.

> Haven't used tokens since this is an independent repo, but that's an easy change.

`

export default {
  title: "UI V2/Tabs",
  id: "components-tabs-kit",
  component: mod.Tabs,
  tags: ["autodocs"],
  parameters: {
    frameHeight: "240px",
    frameBackground: "#fff",
    docs: {
      description: {
        component: docs,
      },
    },
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["normal", "pill", "settings"],
    },
    orientation: {
      control: "select",
      options: ["horizontal", "vertical"],
    },
  },
}

export const Settings = {
  args: {
    variant: "settings",
    orientation: "vertical",
    defaultValue: "general",
  },
  render: (props: TabsProps) => (
    <mod.Tabs {...props}>
      <mod.Tabs.List>
        <mod.Tabs.Trigger value="general">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M6.22266 8.83398C7.43206 8.83422 8.44043 9.69281 8.67188 10.834H14.4453V11.834H8.6709C8.43902 12.9746 7.43167 13.8338 6.22266 13.834C5.01343 13.834 4.00535 12.9747 3.77344 11.834H1.55566V10.834H3.77246C4.00394 9.69266 5.01303 8.83398 6.22266 8.83398ZM6.22266 9.83398C5.39423 9.83398 4.72266 10.5056 4.72266 11.334C4.72292 12.1622 5.39439 12.834 6.22266 12.834C7.0507 12.8337 7.72239 12.162 7.72266 11.334C7.72266 10.5057 7.05086 9.83425 6.22266 9.83398Z"
              fill="currentColor"
            />
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M9.77832 2.16699C10.9876 2.16722 11.996 3.02594 12.2275 4.16699H14.4453V5.16699H12.2275C11.9958 6.30781 10.9875 7.16676 9.77832 7.16699C8.56894 7.16699 7.55987 6.30797 7.32812 5.16699H1.55566V4.16699H7.32812C7.55969 3.02578 8.56878 2.16699 9.77832 2.16699ZM9.77832 3.16699C8.94989 3.16699 8.27832 3.83856 8.27832 4.66699C8.27845 5.49531 8.94997 6.16699 9.77832 6.16699C10.6064 6.16673 11.2782 5.49514 11.2783 4.66699C11.2783 3.83873 10.6065 3.16726 9.77832 3.16699Z"
              fill="currentColor"
            />
          </svg>
          General
        </mod.Tabs.Trigger>
        <mod.Tabs.Trigger value="appearance">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M6.22266 8.83398C7.43206 8.83422 8.44043 9.69281 8.67188 10.834H14.4453V11.834H8.6709C8.43902 12.9746 7.43167 13.8338 6.22266 13.834C5.01343 13.834 4.00535 12.9747 3.77344 11.834H1.55566V10.834H3.77246C4.00394 9.69266 5.01303 8.83398 6.22266 8.83398ZM6.22266 9.83398C5.39423 9.83398 4.72266 10.5056 4.72266 11.334C4.72292 12.1622 5.39439 12.834 6.22266 12.834C7.0507 12.8337 7.72239 12.162 7.72266 11.334C7.72266 10.5057 7.05086 9.83425 6.22266 9.83398Z"
              fill="currentColor"
            />
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M9.77832 2.16699C10.9876 2.16722 11.996 3.02594 12.2275 4.16699H14.4453V5.16699H12.2275C11.9958 6.30781 10.9875 7.16676 9.77832 7.16699C8.56894 7.16699 7.55987 6.30797 7.32812 5.16699H1.55566V4.16699H7.32812C7.55969 3.02578 8.56878 2.16699 9.77832 2.16699ZM9.77832 3.16699C8.94989 3.16699 8.27832 3.83856 8.27832 4.66699C8.27845 5.49531 8.94997 6.16699 9.77832 6.16699C10.6064 6.16673 11.2782 5.49514 11.2783 4.66699C11.2783 3.83873 10.6065 3.16726 9.77832 3.16699Z"
              fill="currentColor"
            />
          </svg>
          Appearance
        </mod.Tabs.Trigger>
      </mod.Tabs.List>
      <mod.Tabs.Content value="general">
        <p class="text-[12px] text-[#5c5c5c] mx-4 my-3.5">General settings</p>
      </mod.Tabs.Content>
      <mod.Tabs.Content value="appearance">
        <p class="text-[12px] text-[#5c5c5c] mx-4 my-3.5">Appearance settings</p>
      </mod.Tabs.Content>
    </mod.Tabs>
  ),
}

export const Normal = {
  args: {
    variant: "normal",
    orientation: "horizontal",
    defaultValue: "first",
  },
  render: (props: TabsProps) => (
    <mod.Tabs {...props}>
      <mod.Tabs.List>
        <mod.Tabs.Trigger value="first">First</mod.Tabs.Trigger>
        <mod.Tabs.Trigger value="second">Second</mod.Tabs.Trigger>
      </mod.Tabs.List>
      <mod.Tabs.Content value="first">
        <p class="text-[12px] text-[#5c5c5c] mx-3.5 my-2">Normal content</p>
      </mod.Tabs.Content>
      <mod.Tabs.Content value="second">
        <p class="text-[12px] text-[#5c5c5c] mx-3.5 my-2">Some more alt content</p>
      </mod.Tabs.Content>
    </mod.Tabs>
  ),
}

export const Pill = {
  args: {
    variant: "pill",
    orientation: "horizontal",
    defaultValue: "first",
  },
  render: (props: TabsProps) => (
    <mod.Tabs {...props}>
      <mod.Tabs.List>
        <mod.Tabs.Trigger value="first">First</mod.Tabs.Trigger>
        <mod.Tabs.Trigger value="second">Second</mod.Tabs.Trigger>
        <mod.Tabs.Trigger value="third">
          Closable
          <mod.Tabs.CloseButton onClick={() => console.log("Close tab-3")} />
        </mod.Tabs.Trigger>
      </mod.Tabs.List>
      <mod.Tabs.Content value="first">
        <p class="text-[12px] text-[#5c5c5c] mx-3.5 my-2">Normal content</p>
      </mod.Tabs.Content>
      <mod.Tabs.Content value="second">
        <p class="text-[12px] text-[#5c5c5c] mx-3.5 my-2">Some more alt content</p>
      </mod.Tabs.Content>
      <mod.Tabs.Content value="third">
        <p class="text-[12px] text-[#5c5c5c] mx-3.5 my-2">Closable content</p>
      </mod.Tabs.Content>
    </mod.Tabs>
  ),
}

export const Closable = {
  args: {
    variant: "normal",
    orientation: "horizontal",
    defaultValue: "tab-1",
  },
  render: (props: TabsProps) => (
    <mod.Tabs {...props}>
      <mod.Tabs.List>
        <mod.Tabs.Trigger value="tab-1">
          Tab 1
          <Show when={true}>
            <mod.Tabs.CloseButton onClick={() => console.log("Close tab-1")} />
          </Show>
        </mod.Tabs.Trigger>
        <mod.Tabs.Trigger value="tab-2">Tab 2</mod.Tabs.Trigger>
      </mod.Tabs.List>
      <mod.Tabs.Content value="tab-1">
        <p class="text-[12px] text-[#5c5c5c] mx-3.5 my-2">Closable content</p>
      </mod.Tabs.Content>
      <mod.Tabs.Content value="tab-2">
        <p class="text-[12px] text-[#5c5c5c] mx-3.5 my-2">Standard content</p>
      </mod.Tabs.Content>
    </mod.Tabs>
  ),
}
