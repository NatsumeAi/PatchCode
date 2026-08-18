export * as BrowserHost from "./browser-host"

import { Context, Effect } from "effect"

export interface Host {
  readonly navigate: (url: string) => Effect.Effect<{ readonly title: string; readonly url: string }>
  readonly snapshot: () => Effect.Effect<{ readonly tree: string }>
  readonly click: (ref: string) => Effect.Effect<{ readonly ok: boolean }>
  readonly type: (ref: string, text: string) => Effect.Effect<{ readonly ok: boolean }>
}

export class HostService extends Context.Service<HostService, Host>()("@opencode/Browser.Host") {}
