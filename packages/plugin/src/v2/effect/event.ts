import type { Event as SDKEvent } from "@opencode-ai/sdk/api/types"
import type { Stream } from "effect"

export type EventMap = {
  [Item in SDKEvent as Item["type"]]: Item
}

export interface Event {
  subscribe<Type extends keyof EventMap>(type: Type): Stream.Stream<EventMap[Type]>
}
