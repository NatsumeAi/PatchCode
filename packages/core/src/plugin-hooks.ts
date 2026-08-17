export * as PluginHooks from "./plugin-hooks"

import { Context, Effect } from "effect"

export type ChatModel = {
  readonly providerID?: string
  readonly modelID?: string
  readonly api?: {
    readonly id?: string
    readonly npm?: string
  }
}

export type ChatMessage = {
  readonly id?: string
  readonly sessionID?: string
}

export interface Chat {
  readonly transformSystem: (input: {
    readonly sessionID: string
    readonly system: string[]
    readonly model?: ChatModel
  }) => Effect.Effect<{ readonly system: string[] }>
  readonly params: (input: {
    readonly sessionID: string
    readonly agent: string
    readonly model?: ChatModel
    readonly message?: ChatMessage
  }) => Effect.Effect<{
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: Record<string, unknown>
    readonly headers: Record<string, string>
  }>
}

export class ChatService extends Context.Service<ChatService, Chat>()("@opencode/v2/PluginChatHook") {}

export interface Command {
  readonly beforeExecute: (input: {
    readonly command: string
    readonly sessionID: string
    readonly arguments: string
    readonly text: string
  }) => Effect.Effect<{ readonly text: string }>
}

export class CommandService extends Context.Service<CommandService, Command>()("@opencode/v2/PluginCommandHook") {}

export interface TextComplete {
  readonly complete: (input: {
    readonly sessionID: string
    readonly messageID: string
    readonly partID: string
    readonly text: string
  }) => Effect.Effect<{ readonly text: string }>
}

export class TextCompleteService extends Context.Service<TextCompleteService, TextComplete>()(
  "@opencode/v2/PluginTextCompleteHook",
) {}

export type PluginChatMessage = {
  info: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

export interface Compaction {
  readonly compacting: (input: { readonly sessionID: string }) => Effect.Effect<{
    readonly context: string[]
    readonly prompt?: string
  }>
  readonly transformMessages: (input: { readonly messages: PluginChatMessage[] }) => Effect.Effect<{
    readonly messages: PluginChatMessage[]
  }>
  readonly autocontinue: (input: {
    readonly sessionID: string
    readonly agent: string
    readonly overflow: boolean
  }) => Effect.Effect<{ readonly enabled: boolean }>
}

export class CompactionService extends Context.Service<CompactionService, Compaction>()(
  "@opencode/v2/PluginCompactionHook",
) {}
