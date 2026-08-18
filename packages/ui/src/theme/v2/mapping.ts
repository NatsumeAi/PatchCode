import type { KitColorValue } from "../types"
import { KIT_AVATAR_DARK, KIT_AVATAR_LIGHT } from "./avatar"

const ref = (name: string): KitColorValue => `var(--${name})`

const lightAgentTokens: Record<string, KitColorValue> = {
  "kit-agent-plan-solid": ref("kit-pink-800"),
  "kit-agent-plan-border": "rgba(200, 61, 139, 0.20)",
  "kit-agent-plan-background": "rgba(253, 236, 243, 0.10)",
  "kit-agent-build-solid": ref("kit-blue-800"),
  "kit-agent-build-border": "rgba(44, 71, 200, 0.20)",
  "kit-agent-build-background": "rgba(236, 241, 254, 0.10)",
  "kit-agent-explore-solid": ref("kit-yellow-900"),
  "kit-agent-explore-border": "rgba(203, 159, 52, 0.20)",
  "kit-agent-explore-background": "rgba(254, 250, 236, 0.1)",
  "kit-agent-review-solid": ref("kit-green-800"),
  "kit-agent-writer-solid": ref("kit-purple-700"),
}

const darkAgentTokens: Record<string, KitColorValue> = {
  "kit-agent-plan-solid": ref("kit-pink-400"),
  "kit-agent-plan-border": "rgba(247, 153, 198, 0.20)",
  "kit-agent-plan-background": "rgba(170, 53, 118, 0.05)",
  "kit-agent-build-solid": ref("kit-blue-300"),
  "kit-agent-build-border": "rgba(162, 188, 255, 0.20)",
  "kit-agent-build-background": "rgba(38, 63, 169, 0.05)",
  "kit-agent-explore-solid": ref("kit-yellow-300"),
  "kit-agent-explore-border": "rgba(243, 218, 155, 0.20)",
  "kit-agent-explore-background": "rgba(172, 136, 51, 0.05)",
  "kit-agent-review-solid": ref("kit-green-300"),
  "kit-agent-writer-solid": ref("kit-purple-400"),
}

const light: Record<string, KitColorValue> = {
  "kit-background-bg-base": ref("kit-grey-100"),
  "kit-background-bg-deep": ref("kit-grey-200"),
  "kit-background-bg-layer-01": ref("kit-grey-300"),
  "kit-background-bg-layer-02": ref("kit-grey-400"),
  "kit-background-bg-layer-03": ref("kit-grey-500"),
  "kit-background-bg-layer-04": ref("kit-grey-600"),
  "kit-background-bg-inverse": ref("kit-grey-1000"),
  "kit-background-bg-contrast": ref("kit-grey-900"),
  "kit-background-bg-button-neutral": ref("kit-grey-100"),
  "kit-background-bg-accent": ref("kit-blue-600"),
  "kit-text-text-inverse": ref("kit-grey-100"),
  "kit-text-text-contrast": ref("kit-grey-100"),
  "kit-text-text-accent": ref("kit-blue-600"),
  "kit-text-text-accent-hover": ref("kit-blue-700"),
  "kit-text-text-code-accent": ref("kit-blue-900"),
  "kit-border-border-muted": ref("kit-alpha-dark-8"),
  "kit-border-border-base": ref("kit-alpha-dark-10"),
  "kit-border-border-strong": ref("kit-alpha-dark-20"),
  "kit-border-border-inverse": ref("kit-grey-1000"),
  "kit-border-border-focus": ref("kit-blue-500"),
  "kit-overlay-simple-overlay-hover": ref("kit-alpha-dark-4"),
  "kit-overlay-simple-overlay-pressed": ref("kit-alpha-dark-8"),
  "kit-overlay-simple-overlay-contrast-hover": ref("kit-alpha-light-12"),
  "kit-overlay-simple-overlay-contrast-pressed": ref("kit-alpha-light-24"),
  "kit-overlay-simple-overlay-scrim": ref("kit-alpha-dark-40"),
  "kit-overlay-gradient-depth-overlay-depth-top": ref("kit-alpha-light-100"),
  "kit-overlay-gradient-depth-overlay-depth-bot": ref("kit-alpha-light-0"),
  "kit-overlay-simple-tab-active-scrim": "#fafafa00",
  "kit-overlay-simple-tab-hover-scrim": "#eeeeee00",
  "kit-overlay-simple-tab-scrim": "#fafafa00",
  "kit-state-bg-success": ref("kit-green-100"),
  "kit-state-fg-success": ref("kit-green-800"),
  "kit-state-border-success": ref("kit-green-300"),
  "kit-state-bg-warning": ref("kit-yellow-100"),
  "kit-state-fg-warning": ref("kit-yellow-800"),
  "kit-state-border-warning": ref("kit-yellow-300"),
  "kit-state-bg-danger": ref("kit-red-100"),
  "kit-state-fg-danger": ref("kit-red-800"),
  "kit-state-border-danger": ref("kit-red-300"),
  "kit-state-bg-info": ref("kit-blue-100"),
  "kit-state-fg-info": ref("kit-blue-800"),
  "kit-state-border-info": ref("kit-blue-300"),
  ...lightAgentTokens,
  ...KIT_AVATAR_LIGHT,
  "kit-elevation-raised":
    "0px 2px 4px 0px var(--kit-alpha-dark-4), 0px 1px 2px -1px var(--kit-alpha-dark-8), 0px 0px 0px 0.5px var(--kit-alpha-dark-12), 0px 0px 0px 0px var(--kit-alpha-dark-0)",
  "kit-elevation-floating":
    "0px 8px 16px 0px var(--kit-alpha-dark-4), 0px 4px 8px 0px var(--kit-alpha-dark-8), 0px 0px 0px 0.5px var(--kit-alpha-dark-12), 0px 0px 0px 0px var(--kit-alpha-dark-0)",
  "kit-elevation-overlay":
    "0px 16px 32px 0px var(--kit-alpha-dark-4), 0px 8px 16px 0px var(--kit-alpha-dark-8), 0px 0px 0px 0.5px var(--kit-alpha-dark-12), 0px 0px 0px 0px var(--kit-alpha-dark-0)",
  "kit-elevation-button-neutral":
    "0px 1px 1.5px 0px var(--kit-alpha-dark-10), 0px 0px 0px 0.5px var(--kit-alpha-dark-14), 0px 0px 0px 0px var(--kit-alpha-dark-0)",
  "kit-elevation-button-contrast":
    "0px 1px 1.5px 0px var(--kit-alpha-dark-20), 0px 0px 0px 0.5px var(--kit-grey-800), inset 0px 1px 2px 0px var(--kit-alpha-light-14), inset 0px -1px 2px 0px var(--kit-alpha-dark-6), 0px 0px 0px 0px var(--kit-alpha-dark-0)",
  "kit-elevation-elements": "0px 0.5px 0.5px 0px var(--kit-alpha-dark-40)",
  "kit-elevation-switch-off":
    "inset 0px 1px 1px 0px var(--kit-alpha-dark-8), inset 0px 0.5px 0.5px 0px var(--kit-alpha-dark-8), inset 0px 0px 0px 0.5px var(--kit-alpha-dark-10)",
  "kit-elevation-switch-on":
    "inset 0px 2px 2px 0px var(--kit-alpha-dark-10), inset 0px 1px 1px 0px var(--kit-alpha-dark-10), inset 0px 0px 0px 0.5px var(--kit-alpha-dark-20)",
  "kit-illustration-illustration-layer-01": ref("kit-grey-300"),
  "kit-illustration-illustration-layer-02": ref("kit-grey-400"),
  "kit-illustration-illustration-layer-03": ref("kit-grey-500"),
}

const dark: Record<string, KitColorValue> = {
  "kit-background-bg-base": ref("kit-grey-1000"),
  "kit-background-bg-deep": ref("kit-grey-1100"),
  "kit-background-bg-layer-01": ref("kit-grey-800"),
  "kit-background-bg-layer-02": ref("kit-grey-600"),
  "kit-background-bg-layer-03": ref("kit-grey-500"),
  "kit-background-bg-layer-04": ref("kit-grey-400"),
  "kit-background-bg-inverse": ref("kit-grey-100"),
  "kit-background-bg-contrast": ref("kit-grey-700"),
  "kit-background-bg-button-neutral": ref("kit-alpha-light-6"),
  "kit-background-bg-accent": ref("kit-blue-600"),
  "kit-text-text-inverse": ref("kit-grey-1000"),
  "kit-text-text-contrast": ref("kit-grey-100"),
  "kit-text-text-accent": ref("kit-blue-400"),
  "kit-text-text-accent-hover": ref("kit-blue-300"),
  "kit-text-text-code-accent": ref("kit-blue-400"),
  "kit-border-border-muted": ref("kit-alpha-light-8"),
  "kit-border-border-base": ref("kit-alpha-light-10"),
  "kit-border-border-strong": ref("kit-alpha-light-20"),
  "kit-border-border-inverse": ref("kit-grey-100"),
  "kit-border-border-focus": ref("kit-blue-500"),
  "kit-overlay-simple-overlay-hover": ref("kit-alpha-light-6"),
  "kit-overlay-simple-overlay-pressed": ref("kit-alpha-light-10"),
  "kit-overlay-simple-overlay-contrast-hover": ref("kit-alpha-dark-24"),
  "kit-overlay-simple-overlay-contrast-pressed": ref("kit-alpha-dark-40"),
  "kit-overlay-simple-overlay-scrim": ref("kit-alpha-dark-60"),
  "kit-overlay-gradient-depth-overlay-depth-top": ref("kit-alpha-light-100"),
  "kit-overlay-gradient-depth-overlay-depth-bot": ref("kit-alpha-light-0"),
  "kit-overlay-simple-tab-active-scrim": "#24242400",
  "kit-overlay-simple-tab-hover-scrim": "#3a3a3a00",
  "kit-overlay-simple-tab-scrim": "#08080800",
  "kit-state-bg-success": ref("kit-green-1200"),
  "kit-state-fg-success": ref("kit-green-500"),
  "kit-state-border-success": ref("kit-green-900"),
  "kit-state-bg-warning": ref("kit-yellow-1200"),
  "kit-state-fg-warning": ref("kit-yellow-500"),
  "kit-state-border-warning": ref("kit-yellow-900"),
  "kit-state-bg-danger": ref("kit-red-1200"),
  "kit-state-fg-danger": ref("kit-red-500"),
  "kit-state-border-danger": ref("kit-red-900"),
  "kit-state-bg-info": ref("kit-blue-1200"),
  "kit-state-fg-info": ref("kit-blue-500"),
  "kit-state-border-info": ref("kit-blue-900"),
  ...darkAgentTokens,
  ...KIT_AVATAR_DARK,
  "kit-elevation-raised":
    "0px 2px 4px 0px var(--kit-alpha-dark-30), 0px 1px 2px 0px var(--kit-alpha-dark-30), 0px 0px 0px 0.5px var(--kit-alpha-light-16), 0px -0.5px 0px 0px var(--kit-alpha-light-6)",
  "kit-elevation-floating":
    "0px 8px 16px 0px var(--kit-alpha-dark-30), 0px 4px 8px 0px var(--kit-alpha-dark-30), 0px 0px 0px 0.5px var(--kit-alpha-light-16), 0px -0.5px 0px 0px var(--kit-alpha-light-6)",
  "kit-elevation-overlay":
    "0px 16px 32px 0px var(--kit-alpha-dark-30), 0px 8px 16px 0px var(--kit-alpha-dark-30), 0px 0px 0px 0.5px var(--kit-alpha-light-16), 0px -0.5px 0px 0px var(--kit-alpha-light-6)",
  "kit-elevation-button-neutral":
    "0px 1px 2px 0px var(--kit-alpha-dark-40), 0px 0px 0px 0.5px var(--kit-alpha-light-20), 0px -0.5px 0px 0px var(--kit-alpha-light-10)",
  "kit-elevation-button-contrast":
    "0px 1px 2px 0px var(--kit-alpha-dark-40), 0px 0px 0px 0.5px var(--kit-alpha-light-40), inset 0px 0px 0px 0px var(--kit-alpha-light-0), inset 0px 0px 0px 0px var(--kit-alpha-light-0), 0px -0.5px 0px 0px var(--kit-alpha-light-30)",
  "kit-elevation-elements": "0px 0.5px 0.5px 0px var(--kit-alpha-dark-40)",
  "kit-elevation-switch-off":
    "inset 0px -0.5px 0px 0px var(--kit-alpha-light-10), inset 0px 0px 0px 0px var(--kit-alpha-light-0), inset 0px 0px 0px 0.5px var(--kit-alpha-light-16)",
  "kit-elevation-switch-on":
    "inset 0px -0.5px 0px 0px var(--kit-alpha-light-10), inset 0px 0px 0px 0px var(--kit-alpha-light-0), inset 0px 0px 0px 0.5px var(--kit-alpha-light-16)",
  "kit-illustration-illustration-layer-01": ref("kit-grey-900"),
  "kit-illustration-illustration-layer-02": ref("kit-grey-800"),
  "kit-illustration-illustration-layer-03": ref("kit-grey-700"),
}

export function mapKitSemantics(isDark: boolean): Record<string, KitColorValue> {
  return isDark ? dark : light
}

export function mergeKitTokens(...layers: Record<string, KitColorValue>[]): Record<string, KitColorValue> {
  return Object.assign({}, ...layers)
}
